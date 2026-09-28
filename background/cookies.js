'use strict';

/**
 * Cookies injetados no carregamento da pagina.
 *
 * Tres fontes combinadas, deduplicadas pela chave "dominio|path|nome":
 *
 *   1. header Set-Cookie (webRequest.onHeadersReceived): pega inclusive os
 *      cookies HttpOnly e da os atributos crus. O Firefox junta varios
 *      Set-Cookie de uma resposta em UM header, separados por "\n"; a divisao
 *      e feita por "\n" e nunca por virgula (o atributo Expires tem virgula);
 *   2. browser.cookies.onChanged: pega cookies escritos por JavaScript
 *      (document.cookie), que nao passam por header;
 *   3. snapshot browser.cookies.getAll ao final do carregamento: estado
 *      consolidado, confirma se o cookie foi de fato armazenado (o Firefox
 *      pode rejeitar cookies de rastreadores) e revela os cookies que ja
 *      existiam antes da visita (pre-existentes, nao contam como injetados).
 *
 * Classificacao exigida pelo enunciado:
 *   - primeira x terceira parte: eTLD+1 do dominio do cookie x dominio da
 *     pagina. Sem "Domain=" no header, o dominio do cookie e o host da
 *     requisicao que o emitiu;
 *   - sessao x persistente: Max-Age > 0 ou Expires no futuro = persistente
 *     (Max-Age tem precedencia sobre Expires); sem isso = sessao.
 *   Tambem sao registrados SameSite, HttpOnly, Secure, particionamento e
 *   duracao acima de 90 dias.
 *
 * Total Cookie Protection
 * -----------------------
 * Por padrao o Firefox particiona os cookies de terceira parte pelo site de
 * topo. getAll({}) devolve apenas os nao particionados; por isso a consulta
 * usa partitionKey: {} (todas as particoes) e firstPartyDomain: null
 * (obrigatorio se privacy.firstparty.isolate estiver ligado).
 *
 * LIMITACAO (documentada em METODOLOGIA.md): cookies.onChanged nao informa a
 * aba. Mitigacao: o evento so e atribuido a uma aba que esteja na janela de
 * carregamento (PL.state.inLoadWindow) E cujo trafego ja tenha contatado o
 * eTLD+1 do cookie (e, se o cookie for particionado, cuja pagina seja o site
 * da particao). Duas abas carregando ao mesmo tempo o mesmo dominio recebem
 * ambas o evento.
 */

var PL = window.PL || (window.PL = {});

(function () {
  var COOKIES_LIMITE = 2000;
  var VALOR_MAX = 1024;
  var DIA_MS = 86400000;
  var LONGO_PRAZO_DIAS = 90;
  var SNAPSHOT_TARDIO_MS = 5000;

  // ------------------------------------------------------------------ utilidades

  function semPonto(dominio) {
    return String(dominio || '').toLowerCase().replace(/^\./, '');
  }

  /** Path padrao de um cookie sem atributo Path (RFC 6265, 5.1.4). */
  function pathPadrao(url) {
    var p;
    try { p = new URL(url).pathname || ''; } catch (e) { return '/'; }
    if (p.charAt(0) !== '/') return '/';
    var i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }

  /** Date.parse tolerante ao formato antigo "Wed, 21-Oct-2025 07:28:00 GMT". */
  function parseData(texto) {
    var t = String(texto || '').replace(/(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/, '$1 $2 $3');
    var ms = Date.parse(t);
    return isNaN(ms) ? null : ms;
  }

  function normalizaSameSite(v) {
    v = String(v || '').toLowerCase();
    if (v === 'no_restriction' || v === 'none') return 'none';
    if (v === 'lax' || v === 'strict') return v;
    return 'unspecified';
  }

  function eTLD1(dominio) {
    return PL.eTLDPlusOne(semPonto(dominio));
  }

  /**
   * Interpreta UMA linha de Set-Cookie. Devolve null se o cookie seria
   * rejeitado pelo navegador (Domain que nao casa com o host).
   */
  function parseSetCookie(linha, urlReq, agora) {
    var partes = String(linha).split(';');
    var par = partes.shift();
    var eq = par.indexOf('=');
    var nome = eq >= 0 ? par.slice(0, eq).trim() : '';
    var valor = eq >= 0 ? par.slice(eq + 1).trim() : par.trim();
    if (!nome && !valor) return null;

    var attrs = {};
    partes.forEach(function (p) {
      var i = p.indexOf('=');
      var k = (i >= 0 ? p.slice(0, i) : p).trim().toLowerCase();
      if (k) attrs[k] = i >= 0 ? p.slice(i + 1).trim() : '';
    });

    var host = PL.hostOf(urlReq);
    if (!host) return null;
    var dominioAttr = semPonto(attrs.domain);
    if (dominioAttr && host !== dominioAttr &&
        host.slice(-(dominioAttr.length + 1)) !== '.' + dominioAttr) {
      return null;
    }
    // Domain que e sufixo publico (ex.: "com.br"): "x.com.br" seria o proprio
    // eTLD+1, entao "com.br" nao e registravel e o navegador rejeita o cookie
    if (dominioAttr && host !== dominioAttr &&
        PL.eTLDPlusOne('x.' + dominioAttr) === 'x.' + dominioAttr) {
      return null;
    }

    // expiracao: Max-Age tem precedencia sobre Expires
    var expira = null;
    var remocao = false;
    if (attrs['max-age'] !== undefined && /^-?\d+$/.test(attrs['max-age'])) {
      var ma = parseInt(attrs['max-age'], 10);
      if (ma <= 0) remocao = true;
      else expira = agora + ma * 1000;
    } else if (attrs.expires !== undefined) {
      var ms = parseData(attrs.expires);
      if (ms !== null) {
        if (ms <= agora) remocao = true;
        else expira = ms;
      }
    }

    var path = attrs.path && attrs.path.charAt(0) === '/' ? attrs.path : pathPadrao(urlReq);
    return {
      nome: nome,
      valor: valor,
      dominio: dominioAttr || host,
      hostOnly: !dominioAttr,
      path: path,
      expira: expira,
      remocao: remocao,
      httpOnly: attrs.httponly !== undefined,
      secure: attrs.secure !== undefined,
      sameSite: normalizaSameSite(attrs.samesite),
      // CHIPS: o proprio site pediu cookie particionado
      particionado: attrs.partitioned !== undefined ? true : null,
      particao: ''
    };
  }

  /** Converte um cookie da API browser.cookies para o formato interno. */
  function dadosDaApi(ck) {
    var pk = ck.partitionKey && ck.partitionKey.topLevelSite;
    return {
      nome: ck.name,
      valor: ck.value,
      dominio: semPonto(ck.domain),
      hostOnly: !!ck.hostOnly,
      path: ck.path || '/',
      expira: ck.session || !ck.expirationDate ? null : Math.round(ck.expirationDate * 1000),
      remocao: false,
      httpOnly: !!ck.httpOnly,
      secure: !!ck.secure,
      sameSite: normalizaSameSite(ck.sameSite),
      particionado: !!pk,
      particao: pk || '',
      storeId: ck.storeId || ''
    };
  }

  function chaveDe(d) {
    return d.dominio + '|' + d.path + '|' + d.nome;
  }

  /** Recalcula os campos derivados que dependem do dominio atual da pagina. */
  function classifica(rec, c, agora) {
    c.terceiraParte = !!rec.pageDomain && c.dominioRegistravel !== rec.pageDomain;
    c.persistente = c.expira !== null && c.expira > agora;
    c.sessao = !c.persistente;
    c.duracaoDias = c.persistente ? Math.round((c.expira - agora) / DIA_MS * 10) / 10 : 0;
    c.longoPrazo = c.duracaoDias > LONGO_PRAZO_DIAS;
    // Sem atributo SameSite o Firefox trata o cookie como None (o "Lax por
    // padrao" nao esta ativo na versao estavel), e a propria API devolve
    // "no_restriction". SameSite=None; Secure: enviado em qualquer contexto
    // cross-site.
    c.sameSiteEfetivo = c.sameSite === 'unspecified' ? 'none' : c.sameSite;
    c.aptoCrossSite = c.sameSiteEfetivo === 'none' && c.secure;
    c.origem = c.fontes.has('header') ? 'http' :
      (c.fontes.has('onChanged') ? 'javascript' : 'preexistente');
  }

  /**
   * Insere ou atualiza um cookie no registro da aba. "fonte" e 'header',
   * 'onChanged' ou 'snapshot'. So as duas primeiras contam como injecao.
   */
  function registraCookie(rec, d, fonte, extra) {
    var agora = Date.now();
    var chave = chaveDe(d);
    var c = rec.cookies.get(chave);

    if (d.remocao) {
      // Set-Cookie com expiracao no passado apaga o cookie
      if (c) c.removido = true;
      return c || null;
    }
    if (!c) {
      if (rec.cookies.size >= COOKIES_LIMITE) {
        rec.cookiesDescartados = (rec.cookiesDescartados || 0) + 1;
        return null;
      }
      c = {
        chave: chave,
        nome: d.nome,
        dominio: d.dominio,
        dominioRegistravel: eTLD1(d.dominio),
        path: d.path,
        fontes: new Set(),
        escritas: 0,
        injetado: false,
        primeiraVez: agora,
        armazenado: null,
        removido: false,
        viaRedirect: false,
        emissor: '',
        particionado: null,
        particao: ''
      };
      rec.cookies.set(chave, c);
    }

    c.valor = String(d.valor || '').slice(0, VALOR_MAX);
    c.hostOnly = d.hostOnly;
    c.expira = d.expira;
    c.httpOnly = d.httpOnly;
    c.secure = d.secure;
    c.sameSite = d.sameSite;
    // valor escrito pelo site no header, preservado mesmo apos a API
    // devolver o valor normalizado pelo navegador
    if (fonte === 'header') c.sameSiteDeclarado = d.sameSite;
    if (d.particionado !== null && d.particionado !== undefined) c.particionado = d.particionado;
    if (d.particao) c.particao = d.particao;
    c.removido = false;
    c.ultimaVez = agora;
    c.fontes.add(fonte);
    if (fonte !== 'snapshot') {
      c.escritas++;
      c.injetado = true;
    }
    if (fonte !== 'header') c.armazenado = true;
    if (extra) {
      if (extra.emissor && !c.emissor) c.emissor = extra.emissor;
      if (extra.viaRedirect) c.viaRedirect = true;
    }
    classifica(rec, c, agora);
    return c;
  }

  /**
   * Dominio contatado apenas como salto de uma cadeia de redirecionamento
   * (ex.: o intermediario T de um bounce A -> T -> B), que nao entra em
   * rec.thirdParties por ser uma requisicao de main_frame.
   */
  function apareceuEmRedirect(rec, d) {
    for (var i = 0; i < rec.redirects.length; i++) {
      if (rec.redirects[i].dominioDe === d) return true;
    }
    return false;
  }

  /**
   * O cookie (da API) pertence ao trafego desta aba? Usado para atribuir
   * eventos sem tabId e para filtrar o snapshot.
   */
  function relevante(rec, ck) {
    if (!rec.pageDomain) return false;
    if (rec.cookieStoreId && ck.storeId && ck.storeId !== rec.cookieStoreId) return false;
    var d = eTLD1(ck.domain);
    if (d !== rec.pageDomain && !rec.thirdParties.has(d) && !apareceuEmRedirect(rec, d)) return false;
    var pk = ck.partitionKey && ck.partitionKey.topLevelSite;
    if (pk && PL.domainOf(pk) !== rec.pageDomain) return false;
    return true;
  }

  // ------------------------------------------------------------------ listeners

  function onHeadersReceived(details) {
    var r = PL.requests.requisicaoConhecida(details);
    if (!r) return;
    var rec = r.rec;
    if (details.cookieStoreId && !rec.cookieStoreId) rec.cookieStoreId = details.cookieStoreId;

    var headers = details.responseHeaders || [];
    var agora = Date.now();
    var viaRedirect = details.type === 'main_frame' &&
      [301, 302, 303, 307, 308].indexOf(details.statusCode) >= 0;
    for (var i = 0; i < headers.length; i++) {
      if (String(headers[i].name).toLowerCase() !== 'set-cookie') continue;
      var linhas = String(headers[i].value || '').split('\n');
      for (var j = 0; j < linhas.length; j++) {
        if (!linhas[j].trim()) continue;
        var d = parseSetCookie(linhas[j], details.url, agora);
        if (!d) continue;
        registraCookie(rec, d, 'header', {
          emissor: String(details.url).slice(0, 256),
          viaRedirect: viaRedirect
        });
      }
    }
  }

  function onChanged(info) {
    var ck = info && info.cookie;
    if (!ck) return;
    var recs = PL.state.all().filter(function (rec) {
      return PL.state.inLoadWindow(rec) && relevante(rec, ck);
    });
    if (!recs.length) return;

    if (info.removed) {
      // "overwrite" e seguido de um evento de insercao do novo valor
      if (info.cause === 'overwrite') return;
      var chave = chaveDe(dadosDaApi(ck));
      recs.forEach(function (rec) {
        var c = rec.cookies.get(chave);
        if (c) c.removido = true;
      });
      return;
    }
    var d = dadosDaApi(ck);
    recs.forEach(function (rec) { registraCookie(rec, d, 'onChanged'); });
  }

  /**
   * Garante o cookieStoreId do registro (janela privativa, container). Um
   * registro criado sem requisicao (pagina do bfcache) ainda nao o conhece.
   */
  function garanteStoreId(tabId, rec) {
    if (rec.cookieStoreId) return Promise.resolve();
    return Promise.resolve().then(function () {
      return browser.tabs.get(tabId);
    }).then(function (tab) {
      if (tab && tab.cookieStoreId) rec.cookieStoreId = tab.cookieStoreId;
    }).catch(function () { /* aba fechada: segue com a loja padrao */ });
  }

  /**
   * Estado consolidado dos cookies da aba. Devolve uma Promise. Tambem marca
   * os cookies vistos so no header e ausentes do navegador como nao
   * armazenados (tipicamente bloqueados pelo Enhanced Tracking Protection).
   */
  function snapshot(tabId) {
    var rec = PL.state.get(tabId);
    if (!rec || !rec.pageDomain) return Promise.resolve(null);
    return garanteStoreId(tabId, rec).then(function () {
      var base = { firstPartyDomain: null };
      if (rec.cookieStoreId) base.storeId = rec.cookieStoreId;
      var consulta = Object.assign({ partitionKey: {} }, base);
      // Promise.resolve().then: erros de schema sao lancados de forma sincrona
      return Promise.resolve().then(function () {
        return browser.cookies.getAll(consulta);
      }).catch(function (e) {
        PL.warn('cookies.getAll com partitionKey falhou, usando consulta simples:', e);
        return browser.cookies.getAll(base);
      });
    }).then(function (lista) {
      if (PL.state.get(tabId) !== rec) return null; // a aba ja navegou
      var vistos = new Set();
      (lista || []).forEach(function (ck) {
        if (!relevante(rec, ck)) return;
        var c = registraCookie(rec, dadosDaApi(ck), 'snapshot');
        if (c) vistos.add(c.chave);
      });
      rec.cookies.forEach(function (c) {
        if (c.fontes.has('header') && !c.removido && !vistos.has(c.chave)) c.armazenado = false;
      });
      rec.cookiesSnapshotEm = Date.now();
      return rec;
    }).catch(function (e) {
      PL.warn('falha no snapshot de cookies da aba ' + tabId + ':', e);
      return null;
    });
  }

  /** Fim do carregamento do documento de topo: snapshot agora e um tardio. */
  function onNavigationCompleted(details) {
    if (details.frameId !== 0) return;
    var tabId = details.tabId;
    var rec = PL.state.get(tabId);
    if (!rec) return;
    snapshot(tabId);
    setTimeout(PL.guard('cookies.snapshotTardio', function () {
      if (PL.state.get(tabId) === rec) snapshot(tabId);
    }), SNAPSHOT_TARDIO_MS);
  }

  /**
   * Resumo dos cookies para o popup, o score e o relatorio. A matriz
   * primeira/terceira x sessao/persistente conta apenas os cookies
   * INJETADOS neste carregamento; os pre-existentes aparecem a parte.
   */
  function resumo(rec) {
    var agora = Date.now();
    var r = {
      injetados: 0,
      preexistentes: 0,
      removidos: 0,
      primeiraParte: 0,
      terceiraParte: 0,
      sessao: 0,
      persistente: 0,
      matriz: {
        primeira: { sessao: 0, persistente: 0 },
        terceira: { sessao: 0, persistente: 0 }
      },
      terceiraPersistente: 0,
      primeiraLongoPrazo: 0,
      longoPrazo: 0,
      aptoCrossSite: 0,
      httpOnly: 0,
      secure: 0,
      particionados: 0,
      naoArmazenados: 0,
      viaHttp: 0,
      viaJavascript: 0
    };
    if (!rec) return r;
    rec.cookies.forEach(function (c) {
      classifica(rec, c, agora);
      if (c.removido) { r.removidos++; return; }
      if (!c.injetado) { r.preexistentes++; return; }
      r.injetados++;
      var parte = c.terceiraParte ? 'terceira' : 'primeira';
      var tipo = c.persistente ? 'persistente' : 'sessao';
      r.matriz[parte][tipo]++;
      r[c.terceiraParte ? 'terceiraParte' : 'primeiraParte']++;
      r[tipo]++;
      if (c.terceiraParte && c.persistente) r.terceiraPersistente++;
      if (!c.terceiraParte && c.longoPrazo) r.primeiraLongoPrazo++;
      if (c.longoPrazo) r.longoPrazo++;
      if (c.aptoCrossSite) r.aptoCrossSite++;
      if (c.httpOnly) r.httpOnly++;
      if (c.secure) r.secure++;
      if (c.particionado) r.particionados++;
      if (c.armazenado === false) r.naoArmazenados++;
      if (c.origem === 'http') r.viaHttp++;
      else if (c.origem === 'javascript') r.viaJavascript++;
    });
    return r;
  }

  PL.cookies = {
    parseSetCookie: parseSetCookie,
    snapshot: snapshot,
    resumo: resumo,

    /** Registra os listeners. Chamado por background/main.js. */
    register: function () {
      browser.webRequest.onHeadersReceived.addListener(
        PL.guard('cookies.onHeadersReceived', onHeadersReceived),
        { urls: ['<all_urls>'] },
        ['responseHeaders']
      );
      browser.cookies.onChanged.addListener(PL.guard('cookies.onChanged', onChanged));
      browser.webNavigation.onCompleted.addListener(PL.guard('cookies.onNavigationCompleted', onNavigationCompleted));
    }
  };
})();
