'use strict';

/**
 * Captura de requisicoes (webRequest) e classificacao primeira/terceira parte.
 *
 * Toda requisicao HTTP(S)/WS(S) feita por uma aba e registrada no registro da
 * aba (background/state.js). A classificacao e SEMPRE por eTLD+1
 * (PL.domainOf), nunca por hostname: "s1.uol.com.br" em "www.uol.com.br" e
 * primeira parte; "googletagmanager.com" e terceira parte.
 *
 * Reset por navegacao
 * -------------------
 * O registro da aba e zerado no onBeforeRequest de main_frame. Um
 * redirecionamento HTTP (301/302/303/307/308) dispara um NOVO onBeforeRequest
 * para a URL de destino, porem com o MESMO requestId. Por isso o reset so
 * acontece quando o requestId do main_frame muda: os saltos de uma mesma
 * navegacao sao acrescentados a rec.redirects e a cadeia A -> T -> B
 * sobrevive para a deteccao de bounce tracking (background/tracking.js).
 *
 * Casos especiais tratados:
 *   - navegacao que nao e efetivada (download, 204/205, erro, botao Parar):
 *     o registro anterior e restaurado, pois a pagina anterior continua na tela;
 *   - pagina restaurada do bfcache (voltar/avancar): nao ha requisicao de
 *     main_frame, entao o reset acontece no webNavigation.onCommitted;
 *   - paginas internas (about:, file:, moz-extension:): registro zerado;
 *   - eventos atrasados de requisicoes da pagina anterior: ignorados, pois so
 *     sao aceitos eventos de requestIds vistos no onBeforeRequest do registro.
 *
 * Nenhum listener deste modulo e bloqueante: uma falha aqui nunca impede a
 * navegacao do usuario.
 */

var PL = window.PL || (window.PL = {});

(function () {
  var FILTRO = { urls: ['<all_urls>'] };
  var LOG_LIMITE = 3000;
  var REDIRECT_LIMITE = 1000;
  var EXEMPLOS_LIMITE = 5;
  var URL_MAX = 4096;
  var CACHE_LIMITE = 5000;
  var EM_VOO_LIMITE = 5000;
  // espera apos o onCompleted do main_frame antes de concluir que a resposta
  // nao sera exibida (o onCompleted pode chegar antes do commit)
  var ESPERA_COMMIT_MS = 3000;

  // registro da pagina anterior, guardado ate a nova navegacao ser efetivada
  var anteriores = new Map();
  // ultima URL efetivada (commit) no frame de topo de cada aba
  var ultimaComitada = new Map();
  // cache hostname -> eTLD+1 (a resolucao pela PSL e o custo dominante)
  var cacheDominio = new Map();

  // tipos de conteudo que o Firefox baixa em vez de exibir
  var TIPO_DOWNLOAD = /^application\/(octet-stream|zip|x-zip|x-7z|x-rar|vnd\.rar|x-tar|gzip|x-gzip|x-bzip2|x-msdownload|x-msi|x-apple-diskimage|vnd\.android\.package-archive)/i;

  function ehUrlWeb(url) {
    return /^(https?|wss?):/i.test(url || '');
  }

  function cortaUrl(url) {
    return url && url.length > URL_MAX ? url.slice(0, URL_MAX) : url;
  }

  /** PL.domainOf com cache por hostname. */
  function dominioDe(url) {
    var host = PL.hostOf(url);
    if (!host) return '';
    var d = cacheDominio.get(host);
    if (d === undefined) {
      if (cacheDominio.size >= CACHE_LIMITE) cacheDominio.clear();
      d = PL.eTLDPlusOne(host);
      cacheDominio.set(host, d);
    }
    return d;
  }

  /** URL do documento de topo da aba a partir dos detalhes do webRequest. */
  function urlDoTopo(details) {
    var anc = details.frameAncestors;
    if (anc && anc.length) return anc[anc.length - 1].url;
    return details.documentUrl || '';
  }

  /**
   * Registro da aba para uma requisicao. Se a extensao foi carregada com a
   * pagina ja aberta, o dominio da pagina ainda nao e conhecido: ele e
   * deduzido do documento de topo informado pelo proprio webRequest.
   */
  function registroDa(details) {
    if (details.tabId === undefined || details.tabId < 0) return null;
    var rec = PL.state.getOrCreate(details.tabId);
    // loja de cookies da aba (normal, privativa, container)
    if (rec && details.cookieStoreId && !rec.cookieStoreId) rec.cookieStoreId = details.cookieStoreId;
    if (rec && !rec.pageDomain) {
      var topo = details.type === 'main_frame' ? details.url : urlDoTopo(details);
      if (ehUrlWeb(topo)) {
        rec.pageUrl = topo;
        rec.pageDomain = dominioDe(topo);
      }
    }
    return rec;
  }

  /** Requisicoes em andamento do registro: requestId -> {dominio, terceira}. */
  function registraEmVoo(rec, requestId, info) {
    var m = rec.emVoo || (rec.emVoo = new Map());
    // requisicoes que nunca terminam (websocket, long-poll) nao podem crescer
    // sem limite: o Map preserva a ordem de insercao, sai a mais antiga
    if (!m.has(requestId) && m.size >= EM_VOO_LIMITE) m.delete(m.keys().next().value);
    m.set(requestId, info);
  }

  /**
   * Registro e dados de uma requisicao ja vista no onBeforeRequest. Eventos de
   * requisicoes desconhecidas (ex.: da pagina anterior, ainda em voo apos a
   * navegacao) devolvem null e sao ignorados.
   */
  function requisicaoConhecida(details) {
    var rec = PL.state.get(details.tabId);
    if (!rec || !rec.emVoo) return null;
    var info = rec.emVoo.get(details.requestId);
    return info ? { rec: rec, info: info } : null;
  }

  function valorHeader(headers, nome) {
    if (!headers) return null;
    for (var i = 0; i < headers.length; i++) {
      if (String(headers[i].name).toLowerCase() === nome) return headers[i].value || '';
    }
    return null;
  }

  function temHeader(headers, nome) {
    return valorHeader(headers, nome) !== null;
  }

  /** Estatisticas de um dominio de terceira parte (criadas sob demanda). */
  function estatisticas(rec, dominio, ts) {
    var st = rec.thirdParties.get(dominio);
    if (!st) {
      st = {
        dominio: dominio,
        requisicoes: 0,
        tipos: new Set(),
        enviouCookie: false,
        recebeuSetCookie: false,
        primeira: ts,
        ultima: ts,
        exemplos: [],
        // classificacao do proprio Firefox (Enhanced Tracking Protection),
        // ex.: tracking_ad, tracking_analytics, fingerprinting
        classificacaoFirefox: new Set(),
        erros: 0,
        ultimoErro: ''
      };
      rec.thirdParties.set(dominio, st);
    }
    return st;
  }

  function registraLog(rec, entrada) {
    rec.requestLog.push(entrada);
    if (rec.requestLog.length > LOG_LIMITE) {
      rec.requestLog.shift();
      rec.requestLogDescartadas = (rec.requestLogDescartadas || 0) + 1;
    }
  }

  // ------------------------------------------------------------------ main_frame

  function trataMainFrame(details, ts) {
    var atual = PL.state.get(details.tabId);
    if (!atual || atual.mainRequestId !== details.requestId) {
      // nova navegacao: zera o registro, guardando o anterior ate o commit
      var origem = (atual && atual.pageUrl) || details.originUrl || '';
      if (atual && atual.mainPending) {
        // a navegacao anterior ainda nao foi efetivada e esta sendo
        // substituida: a pagina na tela continua sendo a guardada em
        // "anteriores", e a origem real e a daquela navegacao
        origem = (atual.navegacao && atual.navegacao.origem) || origem;
      } else if (atual) {
        anteriores.set(details.tabId, atual);
      }
      atual = PL.state.reset(details.tabId, details.url);
      atual.mainRequestId = details.requestId;
      atual.navegacao = {
        requestId: details.requestId,
        origem: origem,
        origemDominio: dominioDe(origem),
        inicio: details.url,
        ts: ts,
        restauradaDoCache: false
      };
      PL.log('nova navegacao na aba', details.tabId, atual.pageDomain);
    } else {
      // novo salto da cadeia de redirecionamento da MESMA navegacao
      atual.pageUrl = details.url;
      atual.pageDomain = dominioDe(details.url);
    }
    // URL final da navegacao pendente, atualizada a cada salto; usada no
    // commit (main.js altera pageUrl/pageDomain, por isso um campo proprio)
    atual.mainUrl = details.url;
    atual.mainPending = true;
  }

  /** A navegacao nao sera efetivada: devolve a aba o registro anterior. */
  function desfazNavegacao(tabId, motivo) {
    var rec = PL.state.get(tabId);
    if (!rec || !rec.mainPending) return;
    rec.mainPending = false;
    var anterior = anteriores.get(tabId);
    anteriores.delete(tabId);
    if (anterior) {
      PL.state.restore(tabId, anterior);
      PL.log('navegacao nao efetivada na aba', tabId, '(' + motivo + '), registro anterior mantido');
    }
  }

  // ------------------------------------------------------------------ listeners

  function onBeforeRequest(details) {
    if (!ehUrlWeb(details.url)) return;
    var ts = details.timeStamp || Date.now();
    if (details.type === 'main_frame' && details.tabId >= 0) trataMainFrame(details, ts);

    var rec = registroDa(details);
    if (!rec) return;
    var dominio = dominioDe(details.url);
    if (!dominio) return;

    var terceira = details.type !== 'main_frame' && !!rec.pageDomain && dominio !== rec.pageDomain;
    registraEmVoo(rec, details.requestId, { dominio: dominio, terceira: terceira, tipo: details.type });

    rec.requests.total++;
    if (terceira) rec.requests.thirdParty++;
    else rec.requests.firstParty++;

    registraLog(rec, {
      url: cortaUrl(details.url),
      dominio: dominio,
      tipo: details.type,
      ts: ts,
      terceiraParte: terceira,
      requestId: details.requestId
    });

    if (!terceira) return;
    var st = estatisticas(rec, dominio, ts);
    st.requisicoes++;
    st.tipos.add(details.type);
    st.ultima = ts;
    if (st.exemplos.length < EXEMPLOS_LIMITE && st.exemplos.indexOf(details.url) < 0) {
      st.exemplos.push(cortaUrl(details.url));
    }
    var cls = details.urlClassification;
    if (cls && cls.thirdParty) {
      cls.thirdParty.forEach(function (c) { st.classificacaoFirefox.add(c); });
    }
  }

  function onSendHeaders(details) {
    var r = requisicaoConhecida(details);
    if (!r || !r.info.terceira) return;
    if (!temHeader(details.requestHeaders, 'cookie')) return;
    estatisticas(r.rec, r.info.dominio, details.timeStamp || Date.now()).enviouCookie = true;
  }

  function onHeadersReceived(details) {
    var r = requisicaoConhecida(details);
    if (!r) return;
    var headers = details.responseHeaders;

    if (details.type === 'main_frame' && r.rec.mainRequestId === details.requestId) {
      // respostas que o Firefox nao exibe: a pagina anterior continua na tela
      var disp = valorHeader(headers, 'content-disposition') || '';
      var tipo = valorHeader(headers, 'content-type') || '';
      if (details.statusCode === 204 || details.statusCode === 205 ||
          /^\s*attachment/i.test(disp) || TIPO_DOWNLOAD.test(tipo)) {
        desfazNavegacao(details.tabId, 'download ou resposta sem conteudo');
        return;
      }
    }

    if (!r.info.terceira) return;
    if (!temHeader(headers, 'set-cookie')) return;
    estatisticas(r.rec, r.info.dominio, details.timeStamp || Date.now()).recebeuSetCookie = true;
  }

  function onBeforeRedirect(details) {
    var r = requisicaoConhecida(details);
    if (!r) return;
    var de = details.url;
    var para = details.redirectUrl || '';
    // redirecionamento interno do navegador/extensoes: upgrade http->https
    // no mesmo host (HSTS, HTTPS-Only) ou desvio para moz-extension:
    var interno = /^moz-extension:/i.test(para) ||
      (PL.hostOf(de) === PL.hostOf(para) && /^http:/i.test(de) && /^https:/i.test(para));
    var redirects = r.rec.redirects;
    redirects.push({
      requestId: details.requestId,
      tipo: details.type,
      de: cortaUrl(de),
      para: cortaUrl(para),
      dominioDe: r.info.dominio,
      dominioPara: dominioDe(para),
      status: details.statusCode,
      setCookie: temHeader(details.responseHeaders, 'set-cookie'),
      interno: interno,
      ts: details.timeStamp || Date.now()
    });
    if (redirects.length > REDIRECT_LIMITE) redirects.shift();
  }

  function onCompleted(details) {
    var r = requisicaoConhecida(details);
    if (!r) return;
    r.rec.emVoo.delete(details.requestId);
    if (details.type !== 'main_frame' || r.rec.mainRequestId !== details.requestId) return;
    var rec = r.rec;
    rec.mainCompletedAt = details.timeStamp || Date.now();
    rec.mainStatus = details.statusCode;
    // resposta completa que nunca foi exibida (ex.: tipo de arquivo que o
    // usuario configurou para baixar): restaura o registro anterior
    var tabId = details.tabId;
    var requestId = details.requestId;
    setTimeout(PL.guard('requests.esperaCommit', function () {
      var atual = PL.state.get(tabId);
      if (atual === rec && rec.mainPending && rec.mainRequestId === requestId) {
        desfazNavegacao(tabId, 'resposta concluida sem ser exibida');
      }
    }), ESPERA_COMMIT_MS);
  }

  function onErrorOccurred(details) {
    var r = requisicaoConhecida(details);
    if (!r) return;
    var rec = r.rec;
    rec.emVoo.delete(details.requestId);
    rec.requests.erros = (rec.requests.erros || 0) + 1;

    if (details.type === 'main_frame' && rec.mainRequestId === details.requestId) {
      if (/NS_BINDING_(ABORTED|RETARGETED)/.test(details.error || '')) {
        // botao Parar, navegacao substituida ou entrega a gerenciador de
        // downloads: a pagina anterior continua na tela
        desfazNavegacao(details.tabId, details.error);
      } else {
        // DNS, conexao recusada, certificado...: o Firefox troca a pagina
        // anterior por uma pagina de erro, entao o registro novo e mantido
        rec.mainPending = false;
        anteriores.delete(details.tabId);
        if (rec.navegacao) {
          rec.navegacao.erro = details.error || 'erro';
          rec.navegacao.urlErro = rec.mainUrl || rec.pageUrl;
        }
      }
      return;
    }
    if (!r.info.terceira) return;
    // ex.: NS_ERROR_TRACKING_URI (bloqueado pelo Firefox ETP),
    // NS_ERROR_ABORT (cancelado por outra extensao ou pela lista de bloqueio)
    var st = estatisticas(rec, r.info.dominio, details.timeStamp || Date.now());
    st.erros++;
    st.ultimoErro = details.error || '';
  }

  function semFragmento(url) {
    var i = (url || '').indexOf('#');
    return i >= 0 ? url.slice(0, i) : (url || '');
  }

  /**
   * Commit do documento de topo.
   *   - URL igual a da navegacao pendente: commit normal, nada a zerar;
   *   - pagina de erro do Firefox da navegacao que acabou de falhar: mantem;
   *   - qualquer outro commit de pagina web: veio do bfcache (voltar/avancar),
   *     de um dominio que o webRequest nao enxerga, ou substituiu a navegacao
   *     pendente -> zera o registro;
   *   - pagina interna (about:, file:, moz-extension:...): zera o registro.
   * As comparacoes usam campos proprios deste modulo (mainUrl, urlErro), e
   * nao pageUrl/pageDomain, que o main.js tambem altera no commit: o
   * resultado nao depende da ordem dos listeners.
   */
  function onCommitted(details) {
    if (details.frameId !== 0) return;
    var url = details.url || '';
    var anteriorUrl = ultimaComitada.get(details.tabId) || '';
    var rec = PL.state.get(details.tabId);
    var nav = rec && rec.navegacao;
    var qualificadores = details.transitionQualifiers || [];
    var voltouAvancou = qualificadores.indexOf('forward_back') >= 0;

    // about:blank inicial de aba nova nao conta como navegacao
    if (/^about:(blank|srcdoc)/i.test(url)) return;

    // pagina de erro exibida antes do onErrorOccurred da navegacao pendente:
    // espera o erro chegar, que ele marca o registro (navegacao.erro)
    if (rec && rec.mainPending && /^about:(neterror|certerror)/i.test(url)) return;

    // pagina de erro da navegacao que acabou de falhar (vale uma unica vez)
    if (nav && nav.urlErro && !rec.mainPending && !voltouAvancou &&
        (semFragmento(url) === semFragmento(nav.urlErro) || /^about:(neterror|certerror)/i.test(url))) {
      nav.urlErro = '';
      ultimaComitada.set(details.tabId, url);
      return;
    }

    ultimaComitada.set(details.tabId, url);
    anteriores.delete(details.tabId);

    if (!/^https?:/i.test(url)) {
      PL.state.reset(details.tabId, '');
      return;
    }

    if (rec && rec.mainPending && semFragmento(url) === semFragmento(rec.mainUrl)) {
      rec.mainPending = false;
      return;
    }

    var novo = PL.state.reset(details.tabId, url);
    novo.mainPending = false;
    novo.navegacao = {
      requestId: null,
      origem: anteriorUrl,
      origemDominio: dominioDe(anteriorUrl),
      inicio: url,
      ts: details.timeStamp || Date.now(),
      restauradaDoCache: voltouAvancou,
      semRequisicao: true
    };
    // sem requisicao nao ha details.cookieStoreId: busca a loja de cookies da
    // aba, para que cookies de outra janela (ex.: privativa) nao sejam atribuidos
    var tabId = details.tabId;
    Promise.resolve().then(function () {
      return browser.tabs.get(tabId);
    }).then(function (tab) {
      if (tab && tab.cookieStoreId && PL.state.get(tabId) === novo && !novo.cookieStoreId) {
        novo.cookieStoreId = tab.cookieStoreId;
      }
    }).catch(function () { /* aba fechada */ });
  }

  function onTabRemoved(tabId) {
    anteriores.delete(tabId);
    ultimaComitada.delete(tabId);
  }

  PL.requests = {
    registroDa: registroDa,
    requisicaoConhecida: requisicaoConhecida,
    dominioDe: dominioDe,
    valorHeader: valorHeader,
    temHeader: temHeader,

    /** Registra os listeners. Chamado por background/main.js. */
    register: function () {
      var wr = browser.webRequest;
      wr.onBeforeRequest.addListener(PL.guard('requests.onBeforeRequest', onBeforeRequest), FILTRO);
      wr.onSendHeaders.addListener(PL.guard('requests.onSendHeaders', onSendHeaders), FILTRO, ['requestHeaders']);
      wr.onHeadersReceived.addListener(PL.guard('requests.onHeadersReceived', onHeadersReceived), FILTRO, ['responseHeaders']);
      wr.onBeforeRedirect.addListener(PL.guard('requests.onBeforeRedirect', onBeforeRedirect), FILTRO, ['responseHeaders']);
      wr.onCompleted.addListener(PL.guard('requests.onCompleted', onCompleted), FILTRO);
      wr.onErrorOccurred.addListener(PL.guard('requests.onErrorOccurred', onErrorOccurred), FILTRO);
      browser.webNavigation.onCommitted.addListener(PL.guard('requests.onCommitted', onCommitted));
      browser.tabs.onRemoved.addListener(PL.guard('requests.onTabRemoved', onTabRemoved));
    }
  };
})();
