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

PL.init = function () {
  PL.log('background iniciado, versao', PL.VERSION);
};

PL.init();
