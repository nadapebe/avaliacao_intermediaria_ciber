'use strict';

/**
 * PrivacyLens - content script (isolated world).
 *
 * Roda em document_start em TODOS os frames (all_frames), inclusive iframes
 * de terceira parte. E isso que revela armazenamento HTML5 de terceiros
 * dentro de iframes, exatamente o que as paginas "storage blocking" e
 * "storage partitioning" do DuckDuckGo testam.
 *
 * Responsabilidades:
 *   1. coletar o armazenamento do cliente (localStorage, sessionStorage,
 *      IndexedDB e document.cookie) em tres momentos: document_end
 *      (DOMContentLoaded), window.load e load + 3 s;
 *   2. ser a ponte entre o script de pagina (content/inject.js, world MAIN)
 *      e o background. O inject.js dispara CustomEvent "__privacylens" com um
 *      texto JSON em "detail"; o texto atravessa a fronteira entre os mundos
 *      sem restricao de Xray, e nenhum listener do site escuta esse evento.
 *
 * Apenas metadados sao enviados: numero de chaves, tamanho e ate 20 nomes de
 * chave truncados em 64 caracteres. Os VALORES armazenados nunca saem da
 * pagina.
 */

(function () {
  var EVENTO_PONTE = '__privacylens';
  var AMOSTRA_LIMITE = 20;
  var NOME_MAX = 64;
  var ATRASO_TARDIO_MS = 3000;
  var EVENTOS_PAGINA_LIMITE = 1000;
  var EVENTO_TAMANHO_MAX = 65536;

  var ehTopo = false;
  try { ehTopo = window === window.top; } catch (e) { ehTopo = false; }

  function corta(texto) {
    texto = String(texto);
    return texto.length > NOME_MAX ? texto.slice(0, NOME_MAX) + '...' : texto;
  }

  /** Envia ao background; falhas (ex.: extensao recarregada) sao ignoradas. */
  function envia(msg) {
    msg.ts = Date.now();
    msg.url = location.href;
    // window.origin e a origem real do documento: em frames about:blank e
    // srcdoc (muito usados por anuncios) ela e herdada do pai, enquanto
    // location.origin seria "null"; so frames sandbox ficam com "null"
    msg.origem = (typeof window.origin === 'string' && window.origin) || location.origin;
    msg.topo = ehTopo;
    try {
      var p = browser.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(function () { /* background indisponivel */ });
    } catch (e) { /* contexto da extensao invalidado */ }
  }

  // ------------------------------------------------------------ armazenamento

  /** Metadados de localStorage ou sessionStorage. */
  function lerArea(nome) {
    var r = { disponivel: false, erro: '', chaves: 0, bytes: 0, amostra: [] };
    try {
      var area = window[nome];
      if (!area) return r;
      r.disponivel = true;
      r.chaves = area.length;
      for (var i = 0; i < area.length; i++) {
        var k = area.key(i);
        if (k === null) continue;
        var v = area.getItem(k) || '';
        // tamanho em UTF-16 (2 bytes por caractere), a mesma unidade usada
        // pelos navegadores na cota de Web Storage
        r.bytes += (k.length + v.length) * 2;
        if (r.amostra.length < AMOSTRA_LIMITE) r.amostra.push(corta(k));
      }
    } catch (e) {
      // ex.: SecurityError em iframe sandbox ou com armazenamento bloqueado
      r.erro = (e && e.name) || String(e);
    }
    return r;
  }

  /** Cookies visiveis ao JavaScript (os HttpOnly nao aparecem aqui). */
  function lerDocumentCookie() {
    var r = { disponivel: false, erro: '', quantidade: 0, nomes: [] };
    try {
      var texto = document.cookie || '';
      r.disponivel = true;
      texto.split(';').forEach(function (par) {
        par = par.trim();
        if (!par) return;
        r.quantidade++;
        var i = par.indexOf('=');
        if (r.nomes.length < AMOSTRA_LIMITE) r.nomes.push(corta(i >= 0 ? par.slice(0, i) : ''));
      });
    } catch (e) {
      r.erro = (e && e.name) || String(e);
    }
    return r;
  }

  /**
   * Bancos IndexedDB da origem via indexedDB.databases(). O hook de
   * indexedDB.open no inject.js complementa esta fonte com os bancos abertos
   * durante o carregamento.
   */
  function lerIndexedDB() {
    var r = { disponivel: false, erro: '', bancos: [] };
    return new Promise(function (resolve) {
      try {
        if (!window.indexedDB || typeof indexedDB.databases !== 'function') {
          resolve(r);
          return;
        }
        r.disponivel = true;
        indexedDB.databases().then(function (lista) {
          (lista || []).forEach(function (db) {
            if (r.bancos.length < AMOSTRA_LIMITE) r.bancos.push(corta(db.name || ''));
          });
          resolve(r);
        }, function (e) {
          r.erro = (e && e.name) || String(e);
          resolve(r);
        });
      } catch (e) {
        r.erro = (e && e.name) || String(e);
        resolve(r);
      }
    });
  }

  function coletar(momento) {
    lerIndexedDB().then(function (idb) {
      envia({
        tipo: 'storage',
        momento: momento,
        dados: {
          localStorage: lerArea('localStorage'),
          sessionStorage: lerArea('sessionStorage'),
          indexedDB: idb,
          documentCookie: lerDocumentCookie()
        }
      });
    });
  }

  function agendaColetas() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { coletar('document_end'); }, { once: true });
    } else {
      coletar('document_end');
    }
    function aposLoad() {
      coletar('load');
      setTimeout(function () { coletar('load+3s'); }, ATRASO_TARDIO_MS);
      observaScriptsInjetados();
    }
    if (document.readyState === 'complete') aposLoad();
    else window.addEventListener('load', aposLoad, { once: true });

    // pagina restaurada do bfcache (voltar/avancar): o content script nao
    // roda de novo, entao a coleta e refeita; o atraso da tempo ao background
    // de zerar o registro da aba antes da mensagem chegar
    window.addEventListener('pageshow', function (ev) {
      if (!ev.persisted) return;
      setTimeout(function () { coletar('bfcache'); }, 500);
      setTimeout(function () { coletar('bfcache+3s'); }, 500 + ATRASO_TARDIO_MS);
    });
  }

  // ------------------------------------------------------------ scripts injetados

  var SCRIPTS_INJETADOS_LIMITE = 200;

  /**
   * <script src> adicionados ao DOM DEPOIS do load: carregamento dinamico
   * de codigo, um dos indicios de hook/hijacking. O background descarta os
   * de primeira parte.
   */
  function observaScriptsInjetados() {
    if (typeof MutationObserver !== 'function') return;
    var vistos = new Set();
    function reporta(el) {
      var src = '';
      try { src = el.src || ''; } catch (e) { return; }
      if (!src || vistos.has(src) || vistos.size >= SCRIPTS_INJETADOS_LIMITE) return;
      vistos.add(src);
      envia({ tipo: 'scriptInjetado', src: String(src).slice(0, 512) });
    }
    function verifica(no) {
      if (!no || no.nodeType !== 1) return;
      if (String(no.nodeName).toUpperCase() === 'SCRIPT') { // XHTML usa minusculas
        reporta(no);
      } else if (no.getElementsByTagName) {
        var lista = no.getElementsByTagName('script');
        for (var i = 0; i < lista.length; i++) reporta(lista[i]);
      }
    }
    var obs = new MutationObserver(function (mutacoes) {
      for (var i = 0; i < mutacoes.length; i++) {
        var nos = mutacoes[i].addedNodes;
        for (var j = 0; j < nos.length; j++) verifica(nos[j]);
      }
      if (vistos.size >= SCRIPTS_INJETADOS_LIMITE) obs.disconnect();
    });
    try {
      obs.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (e) { /* documento sem raiz */ }
  }

  // ------------------------------------------------------------ ponte

  var eventosEnviados = 0;

  /**
   * Eventos do script de pagina (inject.js) repassados ao background. O
   * detail e texto JSON: {tipo: '...', ...}. Limitacao: o site tambem pode
   * disparar este evento; os dados da ponte sao tratados como nao confiaveis
   * pelo background.
   */
  function onEventoPagina(ev) {
    if (typeof ev.detail !== 'string') return;
    // o site controla este evento: sem limite de tamanho, poderia inundar
    // o background com textos enormes
    if (ev.detail.length > EVENTO_TAMANHO_MAX) return;
    if (eventosEnviados >= EVENTOS_PAGINA_LIMITE) return;
    var dados;
    try { dados = JSON.parse(ev.detail); } catch (e) { return; }
    if (!dados || typeof dados.tipo !== 'string') return;
    eventosEnviados++;
    envia({ tipo: 'pagina', evento: dados });
  }

  function avisaPronto() {
    document.dispatchEvent(new CustomEvent(EVENTO_PONTE + ':pronto'));
  }

  // fase de captura do window, registrada antes de qualquer script do site:
  // nenhum listener da pagina consegue interromper os eventos antes
  window.addEventListener(EVENTO_PONTE, onEventoPagina, true);
  // aperto de mao nos dois sentidos, porque a ordem de execucao entre o
  // content script e o inject.js nao e garantida: a ponte avisa "pronto" ao
  // nascer e responde de novo a cada "ping" do inject.js. O inject.js guarda
  // os eventos disparados antes do aviso e os reenvia ao recebe-lo.
  window.addEventListener(EVENTO_PONTE + ':ping', avisaPronto, true);
  avisaPronto();

  // primeira interacao real do usuario com a pagina de topo (clique, tecla
  // ou toque). Usada na deteccao de bounce tracking no cliente: uma pagina
  // intermediaria que redireciona sozinha nunca recebe interacao.
  if (ehTopo) {
    var interagiu = false;
    var aoInteragir = function (ev) {
      if (interagiu || !ev.isTrusted) return;
      interagiu = true;
      envia({ tipo: 'interacao' });
    };
    ['pointerdown', 'keydown', 'touchstart'].forEach(function (tipo) {
      window.addEventListener(tipo, aoInteragir, { capture: true, passive: true });
    });
    // pagina restaurada do bfcache ganha um registro novo no background
    window.addEventListener('pageshow', function (ev) {
      if (ev.persisted) interagiu = false;
    });
  }

  agendaColetas();
})();
