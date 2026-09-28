'use strict';

/**
 * Rastreamento entre dominios: cookie sync, bounce tracking e link decoration.
 *
 * Cookie sync
 * -----------
 * Indice "valor -> {dominio, nome}" com todos os cookies de valor com cara de
 * identificador (8+ caracteres) conhecidos da aba: os de background/cookies.js
 * e os enviados no header Cookie de cada requisicao. A cada requisicao para
 * um dominio B diferente do dominio da pagina, a URL e varrida (valores da
 * query string, segmentos do path, fragmento, valores apos decodeURIComponent,
 * query strings aninhadas e candidatos base64 decodificaveis). Um valor de
 * cookie do dominio A encontrado na URL de B, com A != B:
 *   - A de terceira parte -> "sincronismo" (cookie sync A -> B);
 *   - A = dominio da pagina -> "vazamentoPrimeiraParte" (ID de primeira parte
 *     entregue a um terceiro, ex.: o client id do _ga).
 * Heuristica complementar: um mesmo valor com cara de ID (UUID ou hex com 16+
 * caracteres) em parametros de requisicoes para 2 ou mais terceiros
 * distintos -> "idCompartilhado".
 *
 * A varredura roda online (a cada requisicao) e e refeita sobre o requestLog
 * em analisa(), que tambem enxerga valores de cookie conhecidos depois da
 * requisicao (ex.: pelo snapshot).
 *
 * Bounce tracking
 * ---------------
 * Padrao A -> T -> B, com T de eTLD+1 diferente de A e de B, permanencia
 * curta e T com estado na passagem: grava cookie (Set-Cookie/document.cookie)
 * ou recebe o cookie de uma visita anterior (header Cookie no salto):
 *   - no servidor: saltos 3xx do main_frame da navegacao atual
 *     (rec.redirects, preenchido por requests.js) com Set-Cookie em T;
 *   - no cliente (JavaScript/meta refresh): a pagina anterior T durou ate
 *     BOUNCE_CLIENTE_MAX_MS, nao recebeu nenhuma interacao do usuario
 *     (clique, tecla ou toque, informado pelo content script) e gravou
 *     cookie de primeira parte antes de mandar o usuario para B.
 *
 * Link decoration
 * ---------------
 * Parametros de rastreamento nas URLs de navegacao (gclid, fbclid, utm_*...)
 * e em requisicoes de terceira parte. E o que a pagina "Query parameters" do
 * DuckDuckGo testa.
 *
 * Valores de identificadores nunca sao guardados inteiros: so uma amostra
 * mascarada (primeiros caracteres + tamanho).
 */

var PL = window.PL || (window.PL = {});

(function () {
  var MIN_VALOR = 8;
  var MAX_VALOR = 4096;
  var MAX_CANDIDATO = 2048;
  var SYNC_LIMITE = 300;
  var IDS_LIMITE = 5000;
  var CABECALHO_LIMITE = 2000;
  var DECORACAO_LIMITE = 200;
  var REINDEXA_MS = 1000;
  var BOUNCE_CLIENTE_MAX_MS = 10000;
  var CORRIDA_COOKIE_MS = 3000;

  // parametros de rastreamento (link decoration); utm_* por prefixo
  // (inclui a lista usada pela pagina "Query parameters" do DuckDuckGo)
  var PARAMETROS_DECORACAO = [
    'gclid', 'fbclid', 'msclkid', 'ttclid', 'twclid', 'igshid', '_ga', '_gl',
    'mc_eid', 'yclid', 'dclid', 'gbraid', 'wbraid', '_hsenc', '_hsmi', 'mkt_tok', 'srsltid',
    'fb_source', 'fb_ref', 'fb_action_ids', 'fb_action_types', 'action_object_map',
    'action_type_map', 'action_ref_map', 'gs_l', 'ga_source', 'ga_medium', 'ga_term',
    'ga_content', 'ga_campaign', 'ga_place', 'hmb_campaign', 'hmb_source', 'hmb_medium'
  ];

  // cookies e parametros de consentimento (TCF/GPP/CCPA): o mesmo texto e
  // repassado a todos os anunciantes por exigencia legal, nao e identificador
  var COOKIES_CONSENTIMENTO = /^(euconsent(-v2)?|eupubconsent(-v2)?|__gpp(_sid)?|usprivacy|addtl_consent|OptanonConsent|OptanonAlertBoxClosed|CookieConsent|cookieyes-consent|didomi_token|FCCDCF|FCNEC)$/i;
  var PARAMETROS_CONSENTIMENTO = /^(gdpr_consent|gdpr|gpp|gpp_sid|us_privacy|addtl_consent)$/i;
  // parametros de versao/cache/aleatorios: nao entram no ID compartilhado
  var PARAMETROS_NAO_ID = /^(v|ver|version|hash|h|sha|cb|rnd|rand|random|ord|correlator|_|t|ts|cachebuster)$/i;

  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var HEX16 = /^(?=[0-9]*[a-f])[0-9a-f]{16,}$/i;
  var BASE64 = /^[A-Za-z0-9+\/_-]{12,}={0,2}$/;
  var SEPARADORES = /[^A-Za-z0-9_\-.]+/;
  var VALORES_COMUNS = ['undefined', 'null', 'true', 'false', 'function', 'object'];

  // ------------------------------------------------------------ utilidades

  /** Estado interno deste modulo no registro da aba (criado sob demanda). */
  function estado(rec) {
    if (!rec.tracking) {
      rec.tracking = {
        indice: new Map(),
        indiceEm: 0,
        indiceTamanho: -1,
        cabecalho: new Map(),
        idsVistos: new Map(),
        chavesSync: new Set(),
        decoracaoRequisicoes: [],
        chavesDecoracao: new Set(),
        tokensPagina: null,
        tokensPaginaUrl: '',
        assinaturaVarrida: '',
        // dominios cujo salto de main_frame enviou header Cookie (T "lembra"
        // do usuario mesmo sem gravar cookie novo)
        cookieEnviadoMain: new Set()
      };
    }
    return rec.tracking;
  }

  function decodifica(v) {
    try { return decodeURIComponent(v); } catch (e) { return v; }
  }

  /** Timestamp Unix plausivel (s ou ms): nao e identificador. */
  function pareceTimestamp(t) {
    if (!/^\d+$/.test(t)) return false;
    var n = Number(t);
    if (t.length === 13) n = n / 1000;
    else if (t.length !== 10) return false;
    return n > 946684800 && n < Date.now() / 1000 + 10 * 365 * 86400;
  }

  /** Token com cara de identificador (nao e flag, data, palavra ou numero curto). */
  function pareceId(t) {
    if (!t || t.length < MIN_VALOR || t.length > 512) return false;
    if (VALORES_COMUNS.indexOf(t.toLowerCase()) >= 0) return false;
    var alfanum = t.replace(/[^A-Za-z0-9]/g, '');
    if (alfanum.length < MIN_VALOR) return false;
    if (/^(.)\1+$/.test(alfanum)) return false;
    if (pareceTimestamp(t)) return false;
    if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/.test(t)) return false; // data ISO
    // precisa de digito, ou ser longo com maiusculas e minusculas
    if (/\d/.test(t)) return true;
    return t.length >= 16 && /[a-z]/.test(t) && /[A-Z]/.test(t);
  }

  function idForte(t) {
    return UUID.test(t) || HEX16.test(t);
  }

  /** Amostra mascarada de um identificador (nunca o valor inteiro). */
  function mascara(v) {
    v = String(v);
    return v.slice(0, 4) + '...(' + v.length + ' caracteres)';
  }

  function corta(v, max) {
    v = String(v || '');
    return v.length > max ? v.slice(0, max) : v;
  }

  /** Pedacos de um valor: ele mesmo, pecas por ponto e juncoes de sufixo. */
  function pedacos(v) {
    var out = [v];
    if (v.indexOf('.') >= 0) {
      var partes = v.split('.');
      for (var i = 0; i < partes.length; i++) {
        out.push(partes[i]);
        if (i > 0) out.push(partes.slice(i).join('.'));
      }
    }
    return out;
  }

  /** Tokens de um texto candidato (separado por caracteres nao-ID). */
  function tokensDe(texto) {
    var vistos = new Set();
    function add(t) {
      if (t && t.length >= MIN_VALOR && !vistos.has(t)) vistos.add(t);
    }
    pedacos(texto).forEach(add);
    texto.split(SEPARADORES).forEach(function (t) { pedacos(t).forEach(add); });
    return vistos;
  }

  /** Decodifica base64/base64url se o resultado for texto imprimivel. */
  function base64Texto(v) {
    v = v.replace(/ /g, '+'); // o "+" sem codificacao vira espaco na query string
    if (!BASE64.test(v)) return null;
    try {
      var b = v.replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      var t = atob(b);
      if (!t || t.length < MIN_VALOR) return null;
      for (var i = 0; i < t.length; i++) {
        var c = t.charCodeAt(i);
        if (c < 32 || c > 126) return null;
      }
      return t;
    } catch (e) {
      return null;
    }
  }

  function ehUrlTexto(v) {
    return /^(https?:)?\/\//i.test(v) || /^https?%3A/i.test(v);
  }

  /**
   * Textos candidatos de uma URL, cada um com o parametro de origem.
   * "naQuery" marca valores de parametros (fonte da heuristica de ID
   * compartilhado); "ehUrl" marca valores que sao URLs (ex.: a pagina atual
   * passada como referencia), excluidos dessa heuristica.
   */
  function candidatosDaUrl(url) {
    var out = [];
    var u;
    try { u = new URL(url); } catch (e) { return out; }

    function add(valor, parametro, naQuery, profundidade) {
      if (!valor) return;
      valor = corta(valor, MAX_CANDIDATO);
      var ehUrl = ehUrlTexto(valor);
      out.push({ texto: valor, parametro: parametro, naQuery: naQuery, ehUrl: ehUrl });
      var dec = decodifica(valor);
      if (dec !== valor) out.push({ texto: dec, parametro: parametro, naQuery: naQuery, ehUrl: ehUrl });
      if (profundidade > 0) return;
      // query string aninhada (ex.: redirect=...%3Fuid%3D...)
      if (dec.indexOf('=') > 0) {
        var q = dec.indexOf('?') >= 0 ? dec.slice(dec.indexOf('?') + 1) : dec;
        try {
          new URLSearchParams(q).forEach(function (v, k) {
            add(v, parametro + '>' + k, naQuery, profundidade + 1);
          });
        } catch (e) { /* nao e query string */ }
      }
      var b64 = base64Texto(valor);
      if (b64) add(b64, 'base64:' + parametro, naQuery, profundidade + 1);
    }

    u.searchParams.forEach(function (v, k) {
      if (!PARAMETROS_CONSENTIMENTO.test(k)) add(v, k, true, 0);
    });
    u.pathname.split('/').forEach(function (seg) {
      if (seg) add(decodifica(seg), 'path', false, 0);
    });
    if (u.hash && u.hash.indexOf('=') > 0) {
      try {
        new URLSearchParams(u.hash.slice(1)).forEach(function (v, k) { add(v, '#' + k, true, 0); });
      } catch (e) { /* fragmento sem parametros */ }
    }
    return out;
  }

  // ------------------------------------------------------------ indice de cookies

  function indexaValor(indice, valor, info) {
    valor = String(valor || '');
    if (valor.length < MIN_VALOR || valor.length > MAX_VALOR) return;
    var formas = [valor];
    var dec = decodifica(valor);
    if (dec !== valor) formas.push(dec);
    formas.forEach(function (f) {
      if (f.length > 1 && f.charAt(0) === '"' && f.charAt(f.length - 1) === '"') f = f.slice(1, -1);
      var lista = pedacos(f);
      if (/[|:]/.test(f)) lista = lista.concat(f.split(/[|:]/));
      lista.forEach(function (t) {
        if (pareceId(t) && !indice.has(t)) indice.set(t, info);
      });
    });
  }

  /** (Re)constroi o indice valor -> cookie, no maximo a cada REINDEXA_MS. */
  function indiceDe(rec, forcar) {
    var t = estado(rec);
    var agora = Date.now();
    if (!forcar && t.indiceTamanho === rec.cookies.size && agora - t.indiceEm < REINDEXA_MS) {
      return t.indice;
    }
    var indice = new Map();
    rec.cookies.forEach(function (c) {
      if (c.removido || !c.valor || COOKIES_CONSENTIMENTO.test(c.nome)) return;
      indexaValor(indice, c.valor, { dominio: c.dominioRegistravel, nome: c.nome, fonte: 'cookie' });
    });
    t.cabecalho.forEach(function (info, valor) { indexaValor(indice, valor, info); });
    t.indice = indice;
    t.indiceEm = agora;
    t.indiceTamanho = rec.cookies.size;
    return indice;
  }

  /**
   * Assinatura do conteudo do indice: muda quando um cookie novo aparece ou
   * um valor muda. Evita revarrer o requestLog a cada abertura do popup.
   */
  function assinaturaDoIndice(rec) {
    var ultima = 0;
    rec.cookies.forEach(function (c) { if (c.ultimaVez > ultima) ultima = c.ultimaVez; });
    return rec.cookies.size + ':' + ultima + ':' + estado(rec).cabecalho.size + ':' + rec.requests.total;
  }

  /** Tokens presentes na propria URL da pagina (excluidos do ID compartilhado). */
  function tokensDaPagina(rec) {
    var t = estado(rec);
    if (t.tokensPaginaUrl !== rec.pageUrl) {
      var set = new Set();
      candidatosDaUrl(rec.pageUrl).forEach(function (c) {
        tokensDe(c.texto).forEach(function (tok) { set.add(tok.toLowerCase()); });
      });
      t.tokensPagina = set;
      t.tokensPaginaUrl = rec.pageUrl;
    }
    return t.tokensPagina;
  }

  // ------------------------------------------------------------ deteccao

  function registraSync(rec, info, dominioB, parametro, url, ts, token) {
    var t = estado(rec);
    var tipo = info.dominio === rec.pageDomain ? 'vazamentoPrimeiraParte' : 'sincronismo';
    var chave = tipo + '|' + info.dominio + '|' + dominioB + '|' + info.nome;
    if (t.chavesSync.has(chave) || rec.sync.length >= SYNC_LIMITE) return;
    t.chavesSync.add(chave);
    rec.sync.push({
      tipo: tipo,
      de: info.dominio,
      para: dominioB,
      cookie: info.nome,
      fonteCookie: info.fonte,
      parametro: corta(parametro, 128),
      url: corta(url, 512),
      valorAmostra: mascara(token),
      ts: ts
    });
  }

  /**
   * Libera espaco no mapa de IDs: remove o mais antigo que so apareceu para
   * um dominio (nonces unicos). O Map preserva a ordem de insercao.
   */
  function despejaIdAntigo(mapa) {
    // em lote (10% do limite), para nao percorrer o mapa a cada ID novo
    var alvo = Math.ceil(IDS_LIMITE / 10);
    var removidos = [];
    var it = mapa.entries();
    for (var e = it.next(); !e.done && removidos.length < alvo; e = it.next()) {
      if (e.value[1].dominios.size < 2) removidos.push(e.value[0]);
    }
    removidos.forEach(function (k) { mapa.delete(k); });
    return removidos.length > 0;
  }

  function registraIdCompartilhado(rec, token, dominioB, parametro, url, ts) {
    var t = estado(rec);
    var visto = t.idsVistos.get(token);
    if (!visto) {
      if (t.idsVistos.size >= IDS_LIMITE && !despejaIdAntigo(t.idsVistos)) return;
      visto = { dominios: new Set(), parametros: new Set(), registro: null, url: corta(url, 512), ts: ts };
      t.idsVistos.set(token, visto);
    }
    visto.dominios.add(dominioB);
    visto.parametros.add(corta(parametro, 128));
    if (visto.dominios.size < 2) return;
    if (!visto.registro) {
      if (rec.sync.length >= SYNC_LIMITE) return;
      visto.registro = {
        tipo: 'idCompartilhado',
        de: '',
        para: '',
        dominios: [],
        parametros: [],
        valorAmostra: mascara(token),
        url: visto.url,
        ts: visto.ts
      };
      rec.sync.push(visto.registro);
    }
    visto.registro.dominios = Array.from(visto.dominios);
    visto.registro.parametros = Array.from(visto.parametros);
  }

  function registraDecoracao(lista, chaves, parametro, valor, url, onde, dominio, ts) {
    var chave = onde + '|' + parametro + '|' + (onde === 'requisicao' ? dominio : url);
    if (chaves.has(chave) || lista.length >= DECORACAO_LIMITE) return;
    chaves.add(chave);
    lista.push({
      parametro: parametro,
      valorAmostra: mascara(valor),
      url: corta(url, 512),
      onde: onde,
      dominio: dominio,
      ts: ts
    });
  }

  function ehParametroDecoracao(k) {
    k = String(k).toLowerCase();
    return k.indexOf('utm_') === 0 || PARAMETROS_DECORACAO.indexOf(k) >= 0;
  }

  function decoracoesDaUrl(url, fn) {
    var u;
    try { u = new URL(url); } catch (e) { return; }
    u.searchParams.forEach(function (v, k) {
      if (ehParametroDecoracao(k)) fn(k, v);
    });
  }

  /**
   * Varre uma requisicao para o dominio B (terceira parte). soSync: so a
   * busca de cookie sync (a revarredura de analisa(); ID compartilhado e
   * decoracao ja ficam completos na varredura online).
   */
  function varre(rec, url, dominioB, ts, soSync) {
    if (!dominioB || dominioB === rec.pageDomain || !url) return;
    var indice = indiceDe(rec, false);
    var pagina = tokensDaPagina(rec);
    var t = estado(rec);

    candidatosDaUrl(url).forEach(function (cand) {
      tokensDe(cand.texto).forEach(function (tok) {
        var info = indice.get(tok);
        if (info && info.dominio && info.dominio !== dominioB) {
          registraSync(rec, info, dominioB, cand.parametro, url, ts, tok);
        }
        if (!soSync && cand.naQuery && !cand.ehUrl && !PARAMETROS_NAO_ID.test(cand.parametro) &&
            idForte(tok) && !pagina.has(tok.toLowerCase())) {
          tok = tok.toLowerCase();
          registraIdCompartilhado(rec, tok, dominioB, cand.parametro, url, ts);
        }
      });
    });
    if (soSync) return;

    decoracoesDaUrl(url, function (k, v) {
      registraDecoracao(t.decoracaoRequisicoes, t.chavesDecoracao, k, v, url, 'requisicao', dominioB, ts);
    });
  }

  /** Resumo da pagina anterior, usado na deteccao de bounce no cliente. */
  function resumoAnterior(ant, agora) {
    var cookiesPrimeira = 0;
    ant.cookies.forEach(function (c) {
      if (c.injetado && !c.removido && c.dominioRegistravel === ant.pageDomain) cookiesPrimeira++;
    });
    return {
      url: corta(ant.pageUrl, 512),
      dominio: ant.pageDomain,
      origemDominio: (ant.navegacao && ant.navegacao.origemDominio) || '',
      duracaoMs: agora - ant.startedAt,
      cookiesPrimeiraParte: cookiesPrimeira,
      cookieEnviado: !!(ant.tracking && ant.tracking.cookieEnviadoMain.has(ant.pageDomain)),
      usuarioInteragiu: !!ant.usuarioInteragiu
    };
  }

  /** Bounce tracking: recalculado a partir da cadeia da navegacao atual. */
  function calculaBounce(rec) {
    var lista = [];
    var nav = rec.navegacao || {};
    var A = nav.origemDominio || '';
    var B = rec.pageDomain;

    var saltos = rec.redirects.filter(function (r) {
      return r.tipo === 'main_frame' && r.requestId === rec.mainRequestId && !r.interno;
    });
    if (saltos.length) {
      var nos = [saltos[0].dominioDe];
      saltos.forEach(function (s) { nos.push(s.dominioPara); });
      var vistos = new Set();
      for (var i = 0; i < nos.length - 1; i++) {
        var T = nos[i];
        if (!T || T === B || T === A || vistos.has(T)) continue;
        vistos.add(T);
        var deT = saltos.filter(function (s) { return s.dominioDe === T; });
        if (!deT.length) continue;
        var setCookie = deT.some(function (s) { return s.setCookie; });
        var cookieEnviado = estado(rec).cookieEnviadoMain.has(T);
        var entrada = saltos.filter(function (s) { return s.dominioPara === T; })[0];
        var inicioT = entrada ? entrada.ts : nav.ts;
        lista.push({
          tipo: 'servidor',
          de: A,
          via: T,
          para: B,
          setCookie: setCookie,
          cookieEnviado: cookieEnviado,
          bounce: setCookie || cookieEnviado,
          origemDesconhecida: !A,
          status: deT.map(function (s) { return s.status; }),
          permanenciaMs: Math.max(0, deT[deT.length - 1].ts - (inicioT || deT[0].ts)),
          cadeia: nos.slice()
        });
      }
    }

    var ant = nav.anterior;
    if (ant && ant.dominio && ant.dominio !== B && ant.dominio !== ant.origemDominio &&
        ant.origemDominio && ant.duracaoMs <= BOUNCE_CLIENTE_MAX_MS && !ant.usuarioInteragiu) {
      var gravou = ant.cookiesPrimeiraParte > 0;
      lista.push({
        tipo: 'cliente',
        de: ant.origemDominio,
        via: ant.dominio,
        para: B,
        setCookie: gravou,
        cookieEnviado: ant.cookieEnviado,
        bounce: gravou || ant.cookieEnviado,
        origemDesconhecida: false,
        permanenciaMs: ant.duracaoMs,
        cadeia: [ant.origemDominio, ant.dominio, B]
      });
    }
    return lista;
  }

  /** Link decoration nas URLs da navegacao atual (inicio, saltos e pagina). */
  function decoracaoDaNavegacao(rec) {
    var lista = [];
    var chaves = new Set();
    var nav = rec.navegacao || {};
    var urls = [nav.inicio];
    rec.redirects.forEach(function (r) {
      if (r.tipo === 'main_frame' && r.requestId === rec.mainRequestId) urls.push(r.para);
    });
    urls.push(rec.pageUrl);
    urls.forEach(function (url) {
      if (!url) return;
      decoracoesDaUrl(url, function (k, v) {
        registraDecoracao(lista, chaves, k, v, url, 'navegacao', PL.domainOf(url), nav.ts);
      });
    });
    return lista;
  }

  // ------------------------------------------------------------ listeners

  function onBeforeRequest(details) {
    var r = PL.requests.requisicaoConhecida(details);
    if (!r) return;
    var rec = r.rec;
    if (details.type === 'main_frame') {
      // primeira requisicao de uma nova navegacao: guarda o resumo da pagina
      // anterior (T de um possivel bounce no cliente)
      if (rec.mainRequestId === details.requestId && rec.navegacao && !rec.navegacao.anteriorVisto) {
        rec.navegacao.anteriorVisto = true;
        var ant = PL.requests.anterior(details.tabId);
        // so conta se a navegacao partiu da propria pagina anterior (link,
        // JavaScript, meta refresh). URL digitada, favorito ou recarga nao
        // tem originUrl da pagina e nao e bounce.
        var origemReq = details.originUrl ? PL.requests.dominioDe(details.originUrl) : '';
        if (ant && ant !== rec && ant.pageDomain && origemReq === ant.pageDomain) {
          rec.navegacao.anterior = resumoAnterior(ant, details.timeStamp || Date.now());
        }
      }
      return;
    }
    if (!r.info.terceira) return;
    varre(rec, details.url, r.info.dominio, details.timeStamp || Date.now());
  }

  /** Valores enviados no header Cookie: entram no indice de cookie sync. */
  function onSendHeaders(details) {
    var r = PL.requests.requisicaoConhecida(details);
    if (!r) return;
    var cookie = PL.requests.valorHeader(details.requestHeaders, 'cookie');
    if (!cookie) return;
    var t = estado(r.rec);
    if (details.type === 'main_frame') t.cookieEnviadoMain.add(r.info.dominio);
    cookie.split(';').forEach(function (par) {
      var i = par.indexOf('=');
      if (i <= 0) return;
      var nome = par.slice(0, i).trim();
      var valor = par.slice(i + 1).trim();
      if (valor.length < MIN_VALOR || COOKIES_CONSENTIMENTO.test(nome)) return;
      if (t.cabecalho.has(valor) || t.cabecalho.size >= CABECALHO_LIMITE) return;
      var info = { dominio: r.info.dominio, nome: nome, fonte: 'header Cookie' };
      t.cabecalho.set(valor, info);
      indexaValor(t.indice, valor, info); // sem reconstruir o indice inteiro
    });
  }

  /**
   * Cookie gravado por JavaScript em T pode chegar (cookies.onChanged) depois
   * da primeira requisicao da navegacao para B, quando o resumo de T ja foi
   * feito: atualiza o resumo se o cookie e do dominio de T.
   */
  function onCookieChanged(info) {
    if (!info || info.removed || !info.cookie) return;
    var d = PL.eTLDPlusOne(String(info.cookie.domain || '').replace(/^\./, '').toLowerCase());
    var agora = Date.now();
    var ck = info.cookie;
    var particao = ck.partitionKey && ck.partitionKey.topLevelSite;
    // cookie particionado sob outro site: T carregado como terceiro, nao
    // como pagina de topo (nao e cookie de primeira parte de T)
    if (particao && PL.domainOf(particao) !== d) return;
    PL.state.all().forEach(function (rec) {
      var ant = rec.navegacao && rec.navegacao.anterior;
      if (!ant || ant.dominio !== d || agora - (rec.navegacao.ts || 0) > CORRIDA_COOKIE_MS) return;
      if (rec.cookieStoreId && ck.storeId && ck.storeId !== rec.cookieStoreId) return; // outra janela/container
      ant.cookiesPrimeiraParte++;
    });
  }

  /**
   * Analise completa da aba (chamada pelo relatorio e pelo score): refaz a
   * varredura de cookie sync sobre o requestLog com o indice atualizado e
   * recalcula bounce e link decoration.
   */
  function analisa(rec) {
    if (!rec) return null;
    indiceDe(rec, true);
    var t = estado(rec);
    var assinatura = assinaturaDoIndice(rec);
    if (assinatura !== t.assinaturaVarrida) {
      rec.requestLog.forEach(function (e) {
        if (e.terceiraParte && e.tipo !== 'main_frame') varre(rec, e.url, e.dominio, e.ts, true);
      });
      t.assinaturaVarrida = assinatura;
    }
    rec.bounce = calculaBounce(rec);
    rec.decoration = decoracaoDaNavegacao(rec).concat(estado(rec).decoracaoRequisicoes);
    return resumo(rec);
  }

  function resumo(rec) {
    var r = {
      sincronismos: 0,
      paresSync: 0,
      vazamentosPrimeiraParte: 0,
      idsCompartilhados: 0,
      bounces: 0,
      redirecionamentosSemCookie: 0,
      decoracoes: 0
    };
    if (!rec) return r;
    var pares = new Set();
    rec.sync.forEach(function (s) {
      if (s.tipo === 'sincronismo') {
        r.sincronismos++;
        pares.add(s.de + '>' + s.para);
      } else if (s.tipo === 'vazamentoPrimeiraParte') {
        r.vazamentosPrimeiraParte++;
      } else if (s.tipo === 'idCompartilhado') {
        r.idsCompartilhados++;
      }
    });
    r.paresSync = pares.size;
    rec.bounce.forEach(function (b) {
      if (b.bounce) r.bounces++;
      else r.redirecionamentosSemCookie++;
    });
    r.decoracoes = rec.decoration.length;
    return r;
  }

  PL.tracking = {
    analisa: analisa,
    resumo: resumo,
    candidatosDaUrl: candidatosDaUrl,
    pareceId: pareceId,

    /** Registra os listeners. Chamado por background/main.js. */
    register: function () {
      var filtro = { urls: ['<all_urls>'] };
      browser.webRequest.onBeforeRequest.addListener(PL.guard('tracking.onBeforeRequest', onBeforeRequest), filtro);
      browser.webRequest.onSendHeaders.addListener(PL.guard('tracking.onSendHeaders', onSendHeaders), filtro, ['requestHeaders']);
      browser.cookies.onChanged.addListener(PL.guard('tracking.onCookieChanged', onCookieChanged));
    }
  };
})();
