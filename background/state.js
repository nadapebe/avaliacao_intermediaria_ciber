'use strict';

/**
 * Store em memoria com um registro por aba.
 *
 * O registro e zerado a cada navegacao de main_frame, porque todas as
 * metricas do PrivacyLens sao "por carregamento de pagina": o enunciado pede
 * a quantidade de cookies injetados NO CARREGAMENTO de uma pagina, e nao o
 * acumulado do perfil do navegador.
 *
 * Janela de carregamento
 * ----------------------
 * Eventos como cookies.onChanged nao informam a aba de origem. Para atribuir
 * esses eventos a uma pagina sem errar, o registro guarda o instante do inicio
 * da navegacao e so aceita eventos dentro de LOAD_WINDOW_MS cujo dominio ja
 * tenha aparecido no trafego daquela aba. Essa limitacao esta documentada em
 * METODOLOGIA.md.
 */

var PL = window.PL || (window.PL = {});

(function () {
  var LOAD_WINDOW_MS = 30000;

  var tabs = new Map();

  function newRecord(tabId, url) {
    return {
      tabId: tabId,
      pageUrl: url || '',
      pageDomain: url ? PL.domainOf(url) : '',
      startedAt: Date.now(),

      // contadores gerais de requisicao
      requests: { total: 0, firstParty: 0, thirdParty: 0 },

      // log limitado de requisicoes, usado na deteccao de cookie sync e na
      // conferencia contra o HAR exportado do DevTools
      requestLog: [],

      // dominio de terceira parte -> estatisticas
      thirdParties: new Map(),

      // "dominio|path|nome" -> registro de cookie
      cookies: new Map(),

      // origem do frame -> armazenamento HTML5 observado
      storage: new Map(),

      // fingerprinting
      fingerprint: { canvas: [], vectors: new Map() },

      // rastreamento entre dominios
      sync: [],
      bounce: [],
      decoration: [],
      redirects: [],

      // indicios de sequestro de navegador
      hijack: [],

      // bloqueio pela lista personalizada
      blocked: { count: 0, byDomain: new Map() },

      score: null
    };
  }

  PL.state = {
    LOAD_WINDOW_MS: LOAD_WINDOW_MS,

    /** Recupera o registro da aba, criando um vazio se necessario. */
    getOrCreate: function (tabId, url) {
      if (tabId === undefined || tabId === null || tabId < 0) return null;
      var rec = tabs.get(tabId);
      if (!rec) {
        rec = newRecord(tabId, url);
        tabs.set(tabId, rec);
      } else if (url && !rec.pageUrl) {
        rec.pageUrl = url;
        rec.pageDomain = PL.domainOf(url);
      }
      return rec;
    },

    get: function (tabId) {
      return tabs.get(tabId) || null;
    },

    /** Zera o registro da aba. Chamado a cada navegacao de main_frame. */
    reset: function (tabId, url) {
      var rec = newRecord(tabId, url);
      tabs.set(tabId, rec);
      return rec;
    },

    /**
     * Devolve a aba um registro anterior. Usado quando uma navegacao de
     * main_frame nao chega a ser efetivada (download, resposta 204, usuario
     * clicou em Parar): a pagina anterior continua na tela, e seus dados tambem.
     */
    restore: function (tabId, rec) {
      if (rec) tabs.set(tabId, rec);
      return rec;
    },

    /**
     * Todos os registros. Usado para atribuir eventos que nao informam a aba
     * (ex.: cookies.onChanged).
     */
    all: function () {
      return Array.from(tabs.values());
    },

    remove: function (tabId) {
      tabs.delete(tabId);
    },

    /** Verdadeiro enquanto a aba ainda esta na janela de carregamento. */
    inLoadWindow: function (rec) {
      return !!rec && (Date.now() - rec.startedAt) <= LOAD_WINDOW_MS;
    },

    /** Numero de abas monitoradas (usado em diagnostico). */
    size: function () {
      return tabs.size;
    }
  };
})();
