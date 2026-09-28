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

PL.log = function () {
  var args = Array.prototype.slice.call(arguments);
  args.unshift('[PrivacyLens]');
  console.log.apply(console, args);
};

PL.warn = function () {
  var args = Array.prototype.slice.call(arguments);
  args.unshift('[PrivacyLens]');
  console.warn.apply(console, args);
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
  browser.webNavigation.onCommitted.addListener(onCommitted);
  browser.tabs.onRemoved.addListener(function (tabId) {
    PL.state.remove(tabId);
  });
  PL.log('background iniciado, versao', PL.VERSION);
};

PL.init();
