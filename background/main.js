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

PL.init = function () {
  // erros nao capturados em qualquer modulo tambem vao para a aba "Erros"
  window.addEventListener('error', function (ev) {
    PL.warn('erro nao tratado:', ev.message, (ev.filename || '') + ':' + (ev.lineno || ''));
  });
  window.addEventListener('unhandledrejection', function (ev) {
    PL.warn('promise rejeitada:', ev.reason);
  });

  // modulos com listeners proprios, na ordem de registro
  var modulos = [['requests', PL.requests]];
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

  browser.webNavigation.onCommitted.addListener(PL.guard('main.onCommitted', onCommitted));
  browser.tabs.onRemoved.addListener(PL.guard('main.onTabRemoved', function (tabId) {
    PL.state.remove(tabId);
  }));
  PL.log('background iniciado, versao', PL.VERSION);
};

PL.init();
