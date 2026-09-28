'use strict';

/**
 * Indicios de sequestro de navegador (hijacking) e de hook.
 *
 * Indicios coletados:
 *   1. WebSocket para terceira parte: webRequest type "websocket" e o
 *      construtor WebSocket instrumentado no inject.js (com o script de origem);
 *   2. polling persistente: a mesma URL (host + caminho, sem a query) de
 *      terceira parte (ou de outra origem em endereco IP, caso do BeEF em
 *      laboratorio) requisitada POLLING_MIN vezes ou mais, com intervalo
 *      mediano abaixo de POLLING_INTERVALO_MS, ritmo regular e ao longo de
 *      pelo menos POLLING_DURACAO_MS (padrao de canal de comando, como o
 *      polling do BeEF; rajadas de pixels no carregamento e analytics
 *      disparado pelo usuario, em ritmo irregular, nao contam);
 *   3. script injetado em runtime: <script src> de terceira parte adicionado
 *      ao DOM depois do load (MutationObserver no content.js);
 *   4. hook de APIs nativas: o inject.js guarda as referencias de fetch,
 *      XMLHttpRequest, WebSocket, sendBeacon, addEventListener, pushState,
 *      window.open e do descritor de document.cookie logo apos a propria
 *      instrumentacao e as compara no DOMContentLoaded, no load e 3 s depois;
 *      a troca de referencia e um hook do site. O script responsavel e
 *      identificado quando o hook repassa a chamada a funcao original;
 *   5. keylogging / session recording: listeners de teclado/digitacao e de
 *      mouse registrados por script de terceira parte, e dominios conhecidos
 *      de gravacao de sessao;
 *   6. assinatura BeEF: script de terceira parte chamado hook.js combinado
 *      com polling persistente para o mesmo host.
 *
 * As instrumentacoes do proprio PrivacyLens ficam fora da deteccao (o
 * inject.js tira o retrato das referencias depois de instalar os proprios
 * wrappers). Outras extensoes que alteram a pagina (ex.: scriptlets do
 * uBlock Origin) aparecem como hook: os testes devem usar um perfil limpo.
 */

var PL = window.PL || (window.PL = {});

(function () {
  var POLLING_MIN = 5;
  var POLLING_INTERVALO_MS = 15000;
  var POLLING_DURACAO_MS = 30000;
  var POLLING_CHAVES_LIMITE = 500;
  var POLLING_TS_LIMITE = 50;
  // regularidade: fracao minima de intervalos dentro de +-30% da mediana
  // (um canal de comando consulta em ritmo fixo; analytics dispara conforme
  // o usuario age, em intervalos irregulares)
  var POLLING_REGULARIDADE = 0.7;
  var LISTA_LIMITE = 200;

  // hosts conhecidos de gravacao de sessao (session replay): os provedores da
  // lista de Princeton (2017) usada pelo Blacklight e outros atuais. Casam
  // pelo host (ou sufixo), para que "mc.yandex.ru" nao pegue todo yandex.ru.
  var SESSION_RECORDING = [
    'hotjar.com', 'hotjar.io', 'clarity.ms', 'fullstory.com', 'smartlook.com', 'smartlook.cloud',
    'mouseflow.com', 'luckyorange.com', 'luckyorange.net', 'inspectlet.com', 'logrocket.com',
    'lr-ingest.io', 'lr-in.com', 'contentsquare.net', 'quantummetric.com', 'sessioncam.com',
    'clicktale.net', 'decibelinsight.net', 'mc.yandex.ru', 'mc.yandex.com', 'mc.webvisor.org'
  ];

  function hostDeGravacao(host) {
    for (var i = 0; i < SESSION_RECORDING.length; i++) {
      var p = SESSION_RECORDING[i];
      if (host === p || host.slice(-(p.length + 1)) === '.' + p) return p;
    }
    return '';
  }

  var EVENTOS_TECLADO = ['keydown', 'keypress', 'keyup', 'input'];
  var EVENTOS_MOUSE = ['mousemove'];

  function texto(v, max) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return '';
    return String(v).slice(0, max || 512);
  }

  function dados(rec) {
    if (!rec.hijackDados) {
      rec.hijackDados = {
        websockets: new Map(),   // url -> {url, dominio, scripts, viaWebRequest, viaPagina}
        polling: new Map(),      // dominio|host|caminho -> {dominio, host, caminho, tipos, ts[]}
        scriptsInjetados: new Map(), // src -> {src, dominio, frameOrigem}
        hooks: new Map(),        // api -> {api, momentos, nativo, trecho, sombreamento, scripts}
        listeners: new Map(),    // evento|script -> {evento, script, dominio, alvo}
        hookJs: new Map()        // url -> dominio (scripts chamados hook.js)
      };
    }
    return rec.hijackDados;
  }

  function origemDoScript(rec, url) {
    url = texto(url);
    var dominio = /^(https?|blob):/i.test(url) ? PL.domainOf(url.replace(/^blob:/i, '')) : '';
    return { script: url, dominio: dominio, terceiraParte: !!dominio && dominio !== rec.pageDomain };
  }

  /**
   * Evento de um iframe de outro site sobre ele mesmo (ex.: atalhos de
   * teclado do player do YouTube embutido, anuncio que envolve o proprio
   * fetch)? Isso nao atinge a pagina que o usuario visita e e descartado.
   */
  function doProprioIframe(rec, msg, sender, dominioScript) {
    if (!sender || sender.frameId === 0) return false;
    var f = PL.domainOf(texto(msg && msg.origem));
    if (!f || f === rec.pageDomain) return false;
    return dominioScript === undefined || dominioScript === f;
  }

  function limitado(mapa) {
    return mapa.size >= LISTA_LIMITE;
  }

  // ------------------------------------------------------------ webRequest

  /** Origem (esquema + host + porta) da pagina, ou '' se indisponivel. */
  function origemDaPagina(rec) {
    try { return new URL(rec.pageUrl).origin; } catch (e) { return ''; }
  }

  function onBeforeRequest(details) {
    var r = PL.requests.requisicaoConhecida(details);
    if (!r) return;
    var u;
    try { u = new URL(details.url); } catch (e) { return; }
    // terceira parte, ou a mesma parte em OUTRA origem: no laboratorio o
    // BeEF costuma rodar no mesmo host da pagina em outra porta
    // (ex.: 127.0.0.1:8000 e 127.0.0.1:3000)
    var outraOrigem = u.origin !== origemDaPagina(r.rec) && /^(https?|wss?):$/.test(u.protocol);
    var hostLocal = PL.isIpHost(u.hostname) || u.hostname === 'localhost';
    if (!r.info.terceira && !(outraOrigem && hostLocal)) return;
    var dominioIndicio = r.info.terceira ? r.info.dominio : u.host;
    var d = dados(r.rec);
    var ts = details.timeStamp || Date.now();

    if (details.type === 'websocket') {
      var ws = d.websockets.get(u.href);
      if (!ws && !limitado(d.websockets)) {
        ws = { url: u.href.slice(0, 512), dominio: dominioIndicio, scripts: [], viaWebRequest: true, viaPagina: false, ts: ts };
        d.websockets.set(u.href, ws);
      }
      if (ws) ws.viaWebRequest = true;
    }

    if (details.type === 'script' && /\/hook\.js$/i.test(u.pathname) && d.hookJs.size < LISTA_LIMITE) {
      d.hookJs.set(details.url.slice(0, 512), { url: details.url.slice(0, 512), dominio: dominioIndicio, host: u.hostname });
    }

    // polling: agrupa pela URL sem a query (cache busters mudam a cada
    // chamada). Midia (video/audio em partes) nao e canal de comando.
    if (details.type === 'media') return;
    var chave = u.host + u.pathname;
    var p = d.polling.get(chave);
    if (!p) {
      if (d.polling.size >= POLLING_CHAVES_LIMITE && !despejaPolling(d.polling, ts)) return;
      p = { dominio: dominioIndicio, host: u.hostname, caminho: u.pathname.slice(0, 256), tipos: new Set(), ts: [] };
      d.polling.set(chave, p);
    }
    p.tipos.add(details.type);
    p.ts.push(ts);
    if (p.ts.length > POLLING_TS_LIMITE) p.ts.shift();
  }

  /**
   * Libera espaco no mapa de polling: remove entradas que nunca se repetiram
   * ou que estao paradas ha mais de POLLING_DURACAO_MS.
   */
  function despejaPolling(mapa, agora) {
    var removidos = [];
    mapa.forEach(function (p, chave) {
      if (removidos.length < 50 &&
          (p.ts.length < 2 || agora - p.ts[p.ts.length - 1] > POLLING_DURACAO_MS)) {
        removidos.push(chave);
      }
    });
    removidos.forEach(function (k) { mapa.delete(k); });
    return removidos.length > 0;
  }

  function mediana(v) {
    if (!v.length) return 0;
    var o = v.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(o.length / 2);
    return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
  }

  // ------------------------------------------------------------ eventos da pagina

  /** WebSocket aberto por script da pagina (inject.js). */
  function onWebSocket(rec, ev) {
    var url = texto(ev.url);
    var u;
    try { u = new URL(url); } catch (e) { return; }
    url = u.href;
    if (!/^wss?:/i.test(url)) return;
    var dominio = PL.domainOf(url);
    if (!dominio) return;
    if (dominio === rec.pageDomain) {
      // mesma regra do webRequest: outra origem em IP/localhost (laboratorio)
      var hostLocal = PL.isIpHost(u.hostname) || u.hostname === 'localhost';
      var hostPagina = '';
      try { hostPagina = new URL(rec.pageUrl).host; } catch (e) { /* */ }
      if (!hostLocal || u.host === hostPagina) return;
      dominio = u.host;
    }
    var d = dados(rec);
    var ws = d.websockets.get(url);
    if (!ws) {
      if (limitado(d.websockets)) return;
      ws = { url: url, dominio: dominio, scripts: [], viaWebRequest: false, viaPagina: true, ts: Date.now() };
      d.websockets.set(url, ws);
    }
    ws.viaPagina = true;
    var o = origemDoScript(rec, ev.script);
    if (o.script && ws.scripts.length < 10 && ws.scripts.indexOf(o.script) < 0) ws.scripts.push(o.script);
  }

  /** Troca de referencia de uma API nativa detectada pelo inject.js. */
  function onHook(rec, ev, msg, sender) {
    var api = texto(ev.api, 64);
    if (!api || doProprioIframe(rec, msg, sender)) return;
    var d = dados(rec);
    var h = d.hooks.get(api);
    if (!h) {
      if (limitado(d.hooks)) return;
      h = { api: api, momentos: [], nativo: false, trecho: '', sombreamento: false, scripts: [] };
      d.hooks.set(api, h);
    }
    var momento = texto(ev.momento, 32);
    if (momento && h.momentos.indexOf(momento) < 0) h.momentos.push(momento);
    h.nativo = ev.nativo === true;
    h.trecho = texto(ev.trecho, 200);
    if (ev.sombreamento === true) h.sombreamento = true;
  }

  /** Script que instalou o hook (visto quando o hook chama a original). */
  function onHookOrigem(rec, ev, msg, sender) {
    if (doProprioIframe(rec, msg, sender)) return;
    var api = texto(ev.api, 64);
    var d = dados(rec);
    var h = d.hooks.get(api);
    if (!h) return;
    var o = origemDoScript(rec, ev.script);
    if (o.script && h.scripts.length < 5 && !h.scripts.some(function (s) { return s.script === o.script; })) {
      h.scripts.push(o);
    }
  }

  /** Listener de teclado/digitacao/mouse registrado por um script. */
  function onListener(rec, ev, msg, sender) {
    var evento = texto(ev.evento, 32);
    if (EVENTOS_TECLADO.indexOf(evento) < 0 && EVENTOS_MOUSE.indexOf(evento) < 0) return;
    var o = origemDoScript(rec, ev.script);
    if (doProprioIframe(rec, msg, sender, o.dominio)) return;
    var d = dados(rec);
    var chave = evento + '|' + o.script;
    if (d.listeners.has(chave) || limitado(d.listeners)) return;
    d.listeners.set(chave, {
      evento: evento,
      script: o.script,
      dominio: o.dominio,
      terceiraParte: o.terceiraParte,
      alvo: texto(ev.alvo, 32)
    });
  }

  /** <script src> adicionado ao DOM depois do load (content.js). */
  function onScriptInjetado(msg, sender) {
    var rec = PL.registroDoRemetente(msg, sender);
    if (!rec) return;
    var src = texto(msg.src);
    if (!/^https?:/i.test(src)) return;
    var dominio = PL.domainOf(src);
    if (!dominio || dominio === rec.pageDomain) return;
    if (doProprioIframe(rec, msg, sender, dominio)) return;
    var d = dados(rec);
    if (d.scriptsInjetados.has(src) || limitado(d.scriptsInjetados)) return;
    d.scriptsInjetados.set(src, { src: src, dominio: dominio, frameOrigem: texto(msg.origem), ts: msg.ts });
  }

  // ------------------------------------------------------------ analise

  function polling(d) {
    var lista = [];
    d.polling.forEach(function (p) {
      if (p.ts.length < POLLING_MIN) return;
      var intervalos = [];
      for (var i = 1; i < p.ts.length; i++) intervalos.push(p.ts[i] - p.ts[i - 1]);
      var med = mediana(intervalos);
      var duracao = p.ts[p.ts.length - 1] - p.ts[0];
      var regulares = intervalos.filter(function (x) { return Math.abs(x - med) <= med * 0.3; }).length;
      var regular = intervalos.length > 0 && regulares / intervalos.length >= POLLING_REGULARIDADE;
      if (med < POLLING_INTERVALO_MS && duracao >= POLLING_DURACAO_MS && regular) {
        lista.push({
          dominio: p.dominio,
          host: p.host,
          caminho: p.caminho,
          requisicoes: p.ts.length,
          intervaloMedianoMs: Math.round(med),
          duracaoMs: duracao,
          regularidade: Math.round(regulares / intervalos.length * 100) / 100,
          tipos: Array.from(p.tipos)
        });
      }
    });
    return lista;
  }

  /**
   * Monta a lista de indicios da aba (rec.hijack). Cada indicio tem tipo,
   * severidade, dominio e a evidencia observada.
   */
  function analisa(rec) {
    if (!rec) return null;
    var d = dados(rec);
    var indicios = [];

    d.websockets.forEach(function (ws) {
      indicios.push({
        tipo: 'websocket',
        severidade: 'media',
        dominio: ws.dominio,
        evidencia: ws.url,
        scripts: ws.scripts.slice()
      });
    });

    var polls = polling(d);
    polls.forEach(function (p) {
      indicios.push({
        tipo: 'polling',
        severidade: 'media',
        dominio: p.dominio,
        evidencia: p.host + p.caminho + ' - ' + p.requisicoes + ' requisicoes, intervalo mediano ' +
          p.intervaloMedianoMs + ' ms em ' + Math.round(p.duracaoMs / 1000) + ' s',
        detalhe: p
      });
    });

    d.scriptsInjetados.forEach(function (s) {
      indicios.push({
        tipo: 'scriptInjetado',
        severidade: 'baixa',
        dominio: s.dominio,
        evidencia: s.src
      });
    });

    // dominios com indicio de canal/captura (websocket, polling, keylogging)
    var suspeitos = new Set();
    indicios.forEach(function (i) {
      if (i.tipo === 'websocket' || i.tipo === 'polling') suspeitos.add(i.dominio);
    });
    d.listeners.forEach(function (l) {
      if (l.terceiraParte && EVENTOS_TECLADO.indexOf(l.evento) >= 0) suspeitos.add(l.dominio);
    });

    // hooks: bibliotecas legitimas de monitoramento (Sentry, New Relic, GTM,
    // gestores de consentimento) tambem envolvem APIs nativas. Severidade:
    // alta so se o mesmo terceiro tem indicio de canal ou captura; media para
    // hook de terceiro; baixa para hook de primeira parte ou sem autoria.
    d.hooks.forEach(function (h) {
      var terceiro = h.scripts.filter(function (s) { return s.terceiraParte; })[0];
      var severidade = !terceiro ? 'baixa' : (suspeitos.has(terceiro.dominio) ? 'alta' : 'media');
      indicios.push({
        tipo: 'hook',
        severidade: severidade,
        dominio: terceiro ? terceiro.dominio : (h.scripts[0] ? h.scripts[0].dominio : ''),
        evidencia: h.api + (h.sombreamento ? ' (sombreado no objeto)' : '') +
          ' alterado em ' + h.momentos.join(', ') + (h.trecho ? ' - codigo: ' + h.trecho : ''),
        api: h.api,
        scripts: h.scripts.slice()
      });
    });

    // keylogging: listener de teclado/digitacao de script de terceira parte
    var teclado = new Map();
    var mouse = new Set();
    d.listeners.forEach(function (l) {
      if (!l.terceiraParte) return;
      if (EVENTOS_TECLADO.indexOf(l.evento) >= 0) {
        var k = teclado.get(l.dominio) || { dominio: l.dominio, eventos: new Set(), scripts: new Set() };
        k.eventos.add(l.evento);
        k.scripts.add(l.script);
        teclado.set(l.dominio, k);
      } else {
        mouse.add(l.dominio);
      }
    });
    teclado.forEach(function (k) {
      indicios.push({
        tipo: 'keylogging',
        severidade: 'media',
        dominio: k.dominio,
        evidencia: 'listeners ' + Array.from(k.eventos).join(', ') + ' registrados por ' +
          Array.from(k.scripts).slice(0, 3).join(', ')
      });
    });

    // session recording: dominio conhecido contatado, ou o mesmo terceiro
    // escutando teclado E mouse
    var gravadores = new Set();
    var conhecidos = new Set();
    function verificaHost(url, dominio) {
      var p = hostDeGravacao(PL.hostOf(url));
      if (p && !conhecidos.has(dominio)) {
        conhecidos.add(dominio);
        gravadores.add(dominio);
      }
    }
    rec.requestLog.forEach(function (e) {
      if (e.terceiraParte && !e.erro) verificaHost(e.url, e.dominio);
    });
    rec.thirdParties.forEach(function (st, dominio) {
      // dominio com todas as requisicoes bloqueadas pelo Firefox: nada foi gravado
      if (st.requisicoes <= (st.bloqueadasFirefox || 0)) return;
      st.exemplos.forEach(function (u) { verificaHost(u, dominio); });
    });
    teclado.forEach(function (k, dominio) {
      if (mouse.has(dominio)) gravadores.add(dominio);
    });
    gravadores.forEach(function (dominio) {
      var conhecido = conhecidos.has(dominio);
      indicios.push({
        tipo: 'sessionRecording',
        severidade: 'media',
        dominio: dominio,
        evidencia: conhecido ? 'dominio conhecido de gravacao de sessao contatado' :
          'o mesmo terceiro escuta teclado e movimento do mouse'
      });
    });

    // assinatura BeEF: hook.js de terceiro + polling persistente ao mesmo host
    d.hookJs.forEach(function (h) {
      var comPolling = polls.some(function (p) { return p.host === h.host || p.dominio === h.dominio; });
      indicios.push({
        tipo: comPolling ? 'beef' : 'hookJs',
        severidade: comPolling ? 'alta' : 'baixa',
        dominio: h.dominio,
        evidencia: h.url + (comPolling ? ' + polling persistente para o mesmo host' : '')
      });
    });

    rec.hijack = indicios;
    return resumo(rec);
  }

  function resumo(rec) {
    var r = { total: 0, porTipo: {}, alta: 0, media: 0, baixa: 0 };
    if (!rec) return r;
    rec.hijack.forEach(function (i) {
      r.total++;
      r.porTipo[i.tipo] = (r.porTipo[i.tipo] || 0) + 1;
      if (r[i.severidade] !== undefined) r[i.severidade]++;
    });
    return r;
  }

  PL.hijack = {
    analisa: analisa,
    resumo: resumo,
    SESSION_RECORDING: SESSION_RECORDING,

    /** Registra os listeners. Chamado por background/main.js. */
    register: function () {
      browser.webRequest.onBeforeRequest.addListener(
        PL.guard('hijack.onBeforeRequest', onBeforeRequest),
        { urls: ['<all_urls>'] }
      );
      PL.onEventoPagina('websocket', onWebSocket);
      PL.onEventoPagina('hook', onHook);
      PL.onEventoPagina('hookOrigem', onHookOrigem);
      PL.onEventoPagina('listener', onListener);
      PL.onMensagem('scriptInjetado', onScriptInjetado);
    }
  };
})();
