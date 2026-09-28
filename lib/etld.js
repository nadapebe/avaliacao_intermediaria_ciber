'use strict';

/**
 * Resolucao de eTLD+1 (dominio registravel) usando a Public Suffix List.
 *
 * Toda a classificacao de primeira/terceira parte do PrivacyLens depende
 * desta funcao. A comparacao e feita entre o eTLD+1 da pagina e o eTLD+1 do
 * recurso requisitado, e nao entre hostnames: "s1.uol.com.br" e
 * "www.uol.com.br" sao a mesma parte; "googletagmanager.com" nao e.
 *
 * Algoritmo (conforme https://publicsuffix.org/list/):
 *   1. se o host casa com uma regra de excecao (!), o sufixo e a regra sem o
 *      primeiro rotulo;
 *   2. senao, procura-se a regra mais especifica que case (curinga tem
 *      prioridade sobre a regra normal de mesmo comprimento);
 *   3. o eTLD+1 e o sufixo acrescido de um rotulo a esquerda.
 */

var PL = window.PL || (window.PL = {});

(function () {
  var normal = null;
  var wildcard = null;
  var exception = null;

  function ensureLoaded() {
    if (normal) return;
    var raw = PL.PSL_RAW || { normal: '', wildcard: '', exception: '' };
    normal = new Set(raw.normal ? raw.normal.split('\n') : []);
    wildcard = new Set(raw.wildcard ? raw.wildcard.split('\n') : []);
    exception = new Set(raw.exception ? raw.exception.split('\n') : []);
  }

  /** Extrai o hostname de uma URL. Retorna '' se a URL nao tiver host. */
  PL.hostOf = function (url) {
    if (!url) return '';
    try {
      var h = new URL(url).hostname || '';
      return h.toLowerCase().replace(/\.$/, '');
    } catch (e) {
      return '';
    }
  };

  /** Verdadeiro para enderecos IPv4/IPv6 literais, que nao tem eTLD+1. */
  PL.isIpHost = function (host) {
    if (!host) return false;
    if (host.indexOf(':') >= 0) return true;
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  };

  /**
   * Retorna o dominio registravel (eTLD+1) de um hostname.
   * Para IPs, hosts locais ou hosts de rotulo unico devolve o proprio host.
   */
  PL.eTLDPlusOne = function (host) {
    ensureLoaded();
    if (!host) return '';
    host = String(host).toLowerCase().replace(/\.$/, '');
    if (PL.isIpHost(host)) return host;

    var labels = host.split('.');
    if (labels.length <= 1) return host;

    // 1. regra de excecao
    for (var i = 0; i < labels.length; i++) {
      var candidate = labels.slice(i).join('.');
      if (exception.has(candidate)) {
        return labels.slice(i).join('.');
      }
    }

    // 2. regra mais especifica (maior numero de rotulos) que case
    var suffixLen = 0;
    for (var j = 0; j < labels.length; j++) {
      var tail = labels.slice(j).join('.');
      var len = labels.length - j;
      if (normal.has(tail) && len > suffixLen) suffixLen = len;
      // curinga: "*.ck" casa "qualquer.ck"
      if (j > 0) {
        var parent = labels.slice(j).join('.');
        if (wildcard.has(parent) && len + 1 > suffixLen) suffixLen = len + 1;
      }
    }

    // 3. host desconhecido na PSL: assume TLD de um rotulo
    if (suffixLen === 0) suffixLen = 1;
    if (suffixLen >= labels.length) return host;

    return labels.slice(labels.length - suffixLen - 1).join('.');
  };

  /** eTLD+1 a partir de uma URL completa. */
  PL.domainOf = function (url) {
    return PL.eTLDPlusOne(PL.hostOf(url));
  };

  /**
   * Verdadeiro quando a URL do recurso pertence a um dominio registravel
   * diferente do dominio da pagina (terceira parte).
   */
  PL.isThirdParty = function (resourceUrl, pageDomain) {
    if (!pageDomain) return false;
    var d = PL.domainOf(resourceUrl);
    if (!d) return false;
    return d !== pageDomain;
  };
})();
