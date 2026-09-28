'use strict';

/**
 * PrivacyLens - ponto de entrada do background script.
 *
 * O carregamento dos modulos e feito pela ordem declarada em manifest.json
 * (background.scripts). Nao ha bundler nem dependencias externas: todos os
 * modulos publicam suas funcoes no namespace global PL.
 */

var PL = window.PL || (window.PL = {});

PL.VERSION = '1.0.0';

/**
 * Falhas capturadas em tempo de execucao. A aba "Erros" do popup lista este
 * buffer, para que erros de execucao sejam visiveis sem abrir o console.
 */
PL.errors = [];
PL.ERRORS_LIMIT = 200;

function formataArgumento(a) {
  // teste por propriedade (e nao instanceof): cobre erros de outros contextos
  if (a && typeof a === 'object' && typeof a.message === 'string') {
    return a.message + (a.stack ? '\n' + a.stack : '');
  }
  if (typeof a === 'object' && a !== null) {
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }
  return String(a);
}

PL.log = function () {
  var args = Array.prototype.slice.call(arguments);
  args.unshift('[PrivacyLens]');
  console.log.apply(console, args);
};

PL.warn = function () {
  var args = Array.prototype.slice.call(arguments);
  try {
    PL.errors.push({ ts: Date.now(), mensagem: args.map(formataArgumento).join(' ') });
    if (PL.errors.length > PL.ERRORS_LIMIT) PL.errors.shift();
  } catch (e) { /* o registro de erro nunca pode gerar outro erro */ }
  args.unshift('[PrivacyLens]');
  console.warn.apply(console, args);
};

/**
 * Envolve um listener em try/catch: a excecao vai para PL.warn (e para a aba
 * "Erros") e o listener devolve undefined, o que no webRequest significa
 * "deixe a requisicao passar". Uma falha do plugin nunca quebra a navegacao.
 */
PL.guard = function (nome, fn) {
  return function () {
    try {
      return fn.apply(this, arguments);
    } catch (e) {
      PL.warn('falha em ' + nome + ':', e);
      return undefined;
    }
  };
};

/**
 * Atualiza a URL e o dominio da pagina quando a navegacao e efetivada.
 * NAO zera o registro: o reset acontece no onBeforeRequest de main_frame
 * (background/requests.js), para que a cadeia de redirecionamentos de uma
 * mesma navegacao sobreviva e possa ser analisada como bounce tracking.
 */
function onCommitted(details) {
  if (details.frameId !== 0) return;
  if (!/^https?:/.test(details.url)) return;
  var rec = PL.state.getOrCreate(details.tabId, details.url);
  if (!rec) return;
  rec.pageUrl = details.url;
  rec.pageDomain = PL.domainOf(details.url);
  PL.log('pagina comprometida na aba', details.tabId, rec.pageDomain);
}

// ---------------------------------------------------------------- mensagens

/**
 * Roteador de mensagens (runtime.onMessage). Cada modulo registra o tratador
 * do seu tipo com PL.onMensagem('tipo', fn). O content script envia 'storage'
 * e 'pagina' (eventos do inject.js); o popup usa tipos proprios.
 */
PL.mensagens = {};

PL.onMensagem = function (tipo, fn) {
  PL.mensagens[tipo] = fn;
};

/** Tratadores dos eventos do script de pagina, pelo campo evento.tipo. */
PL.eventosPagina = {};

PL.onEventoPagina = function (tipo, fn) {
  PL.eventosPagina[tipo] = fn;
};

/**
 * Registro da aba ao qual uma mensagem do content script pertence, ou null
 * se ela for de um documento que ja nao esta na tela:
 *   - coletada antes do inicio da navegacao atual (ts < startedAt);
 *   - navegacao em andamento (o documento antigo ainda envia mensagens);
 *   - frame de topo de outro dominio.
 */
PL.registroDoRemetente = function (msg, sender) {
  if (!sender || !sender.tab || sender.tab.id === undefined) return null;
  var rec = PL.state.get(sender.tab.id);
  if (!rec || !rec.pageDomain || rec.mainPending) return null;
  if (typeof msg.ts === 'number' && msg.ts < rec.startedAt) return null;
  if (sender.frameId === 0 && PL.domainOf(sender.url || msg.url) !== rec.pageDomain) return null;
  return rec;
};

function onMessage(msg, sender) {
  if (!msg || typeof msg.tipo !== 'string') return undefined;
  var fn = PL.mensagens[msg.tipo];
  if (!fn) return undefined;
  return fn(msg, sender);
}

// ---------------------------------------------------------------- storage HTML5

var STORAGE_ORIGENS_LIMITE = 200;
var STORAGE_BANCOS_LIMITE = 50;

/**
 * Armazenamento HTML5 observado pelo content script, agrupado pela origem
 * do frame. Frames da mesma origem compartilham o mesmo armazenamento, entao
 * a coleta mais recente substitui a anterior; o pico de bytes e mantido.
 */
function onStorage(msg, sender) {
  var rec = PL.registroDoRemetente(msg, sender);
  if (!rec || !msg.dados) return;
  var origem = typeof msg.origem === 'string' ? msg.origem : 'null';
  var st = rec.storage.get(origem);
  if (!st) {
    if (rec.storage.size >= STORAGE_ORIGENS_LIMITE) return;
    var dominio = origem === 'null' ? '' : PL.domainOf(origem);
    st = {
      origem: origem,
      dominio: dominio,
      terceiraParte: !!dominio && dominio !== rec.pageDomain,
      topo: false,
      frames: new Set(),
      coletas: 0,
      picoBytesLocal: 0,
      picoBytesSessao: 0,
      bancosIndexedDB: new Set()
    };
    rec.storage.set(origem, st);
  }
  var d = msg.dados;
  st.terceiraParte = !!st.dominio && st.dominio !== rec.pageDomain;
  if (sender.frameId === 0) st.topo = true;
  st.frames.add(sender.frameId);
  st.coletas++;
  st.ultimaColeta = msg.ts;
  st.momento = String(msg.momento || '');
  st.localStorage = d.localStorage || null;
  st.sessionStorage = d.sessionStorage || null;
  st.indexedDB = d.indexedDB || null;
  st.documentCookie = d.documentCookie || null;
  if (d.localStorage) st.picoBytesLocal = Math.max(st.picoBytesLocal, d.localStorage.bytes || 0);
  if (d.sessionStorage) st.picoBytesSessao = Math.max(st.picoBytesSessao, d.sessionStorage.bytes || 0);
  if (d.indexedDB && Array.isArray(d.indexedDB.bancos)) {
    d.indexedDB.bancos.forEach(function (b) {
      if (st.bancosIndexedDB.size < STORAGE_BANCOS_LIMITE) st.bancosIndexedDB.add(String(b));
    });
  }
}

/** Eventos do inject.js (repassados pelo content script). */
function onPagina(msg, sender) {
  var ev = msg.evento;
  if (!ev || typeof ev.tipo !== 'string') return;
  var fn = PL.eventosPagina[ev.tipo];
  if (!fn) return;
  var rec = PL.registroDoRemetente(msg, sender);
  if (!rec) return;
  fn(rec, ev, msg, sender);
}

PL.init = function () {
  // erros nao capturados em qualquer modulo tambem vao para a aba "Erros"
  window.addEventListener('error', function (ev) {
    PL.warn('erro nao tratado:', ev.message, (ev.filename || '') + ':' + (ev.lineno || ''));
  });
  window.addEventListener('unhandledrejection', function (ev) {
    PL.warn('promise rejeitada:', ev.reason);
  });

  // modulos com listeners proprios, na ordem de registro
  var modulos = [
    ['requests', PL.requests],
    ['cookies', PL.cookies]
  ];
  modulos.forEach(function (m) {
    if (!m[1] || typeof m[1].register !== 'function') {
      PL.warn('modulo ausente:', m[0]);
      return;
    }
    try {
      m[1].register();
    } catch (e) {
      PL.warn('falha ao registrar o modulo ' + m[0] + ':', e);
    }
  });

  PL.onMensagem('storage', onStorage);
  PL.onMensagem('pagina', onPagina);
  browser.runtime.onMessage.addListener(PL.guard('main.onMessage', onMessage));

  browser.webNavigation.onCommitted.addListener(PL.guard('main.onCommitted', onCommitted));
  browser.tabs.onRemoved.addListener(PL.guard('main.onTabRemoved', function (tabId) {
    PL.state.remove(tabId);
  }));
  PL.log('background iniciado, versao', PL.VERSION);
};

PL.init();
