'use strict';

/**
 * Relatorio serializavel da aba (popup e exportacao JSON).
 *
 * O registro da aba usa Map e Set, que JSON.stringify nao serializa. Este
 * modulo monta um objeto so com tipos JSON, recalculando antes o score (que
 * atualiza as analises de cookie sync, bounce e hijacking).
 *
 * Privacidade do proprio relatorio: valores de cookies e de armazenamento
 * nao sao copiados para o relatorio, so nomes, tamanhos e uma amostra
 * mascarada do valor do cookie (4 primeiros caracteres + tamanho); nos
 * achados de cookie sync o identificador tambem e mascarado dentro da URL.
 * As URLs de requisicao (exemplos de terceiros, requestLog) sao mantidas
 * inteiras, porque sao a referencia cruzada com o HAR: podem conter
 * identificadores que os proprios rastreadores colocaram nelas. Por isso as
 * medicoes do trabalho usam um perfil limpo, sem login em nenhum site.
 *
 * "erros" sao as falhas globais do plugin (de todas as abas).
 *
 * Mensagens aceitas (so de paginas da propria extensao, como o popup):
 *   {tipo: 'relatorio', tabId}  -> relatorio resumido (sem o requestLog)
 *   {tipo: 'exportar', tabId}   -> baixa o relatorio completo em JSON
 */

var PL = window.PL || (window.PL = {});

(function () {
  var LOG_EXPORTADO_LIMITE = 3000;

  function arr(v) {
    if (!v) return [];
    return Array.from(v);
  }

  function iso(ts) {
    try { return ts ? new Date(ts).toISOString() : null; } catch (e) { return null; }
  }

  function mascara(v) {
    v = String(v || '');
    return v ? v.slice(0, 4) + '...(' + v.length + ' caracteres)' : '';
  }

  /** Mensagem vinda de uma pagina da propria extensao (popup), e nao de um site. */
  function daExtensao(sender) {
    return !!sender && sender.id === browser.runtime.id && /^moz-extension:/i.test(sender.url || '');
  }

  // ------------------------------------------------------------ secoes

  function terceiros(rec) {
    var lista = [];
    rec.thirdParties.forEach(function (st, dominio) {
      var bloqueadasPlugin = rec.blocked && rec.blocked.byDomain ? (rec.blocked.byDomain.get(dominio) || 0) : 0;
      lista.push({
        dominio: dominio,
        requisicoes: st.requisicoes,
        tipos: arr(st.tipos),
        enviouCookie: st.enviouCookie,
        recebeuSetCookie: st.recebeuSetCookie,
        primeira: iso(st.primeira),
        ultima: iso(st.ultima),
        exemplos: st.exemplos.slice(),
        classificacaoFirefox: arr(st.classificacaoFirefox),
        erros: st.erros,
        ultimoErro: st.ultimoErro,
        bloqueadasFirefox: st.bloqueadasFirefox || 0,
        bloqueadasPlugin: bloqueadasPlugin
      });
    });
    lista.sort(function (a, b) { return b.requisicoes - a.requisicoes || (a.dominio < b.dominio ? -1 : 1); });
    return lista;
  }

  function cookies(rec) {
    var resumo = PL.cookies ? PL.cookies.resumo(rec) : null;
    var lista = [];
    rec.cookies.forEach(function (c) {
      lista.push({
        nome: c.nome,
        dominio: c.dominio,
        dominioRegistravel: c.dominioRegistravel,
        path: c.path,
        terceiraParte: c.terceiraParte,
        persistente: c.persistente,
        duracaoDias: c.duracaoDias,
        longoPrazo: c.longoPrazo,
        expira: iso(c.expira),
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
        sameSiteDeclarado: c.sameSiteDeclarado || null,
        sameSiteEfetivo: c.sameSiteEfetivo,
        aptoCrossSite: c.aptoCrossSite,
        hostOnly: c.hostOnly,
        particionado: c.particionado,
        particao: c.particao,
        origem: c.origem,
        fontes: arr(c.fontes),
        injetado: c.injetado,
        armazenado: c.armazenado,
        removido: c.removido,
        viaRedirect: c.viaRedirect,
        emissor: c.emissor,
        escritas: c.escritas,
        valorAmostra: mascara(c.valor),
        primeiraVez: iso(c.primeiraVez)
      });
    });
    // terceiros primeiro, depois por dominio e nome
    lista.sort(function (a, b) {
      if (a.terceiraParte !== b.terceiraParte) return a.terceiraParte ? -1 : 1;
      var x = a.dominioRegistravel + '|' + a.nome;
      var y = b.dominioRegistravel + '|' + b.nome;
      return x < y ? -1 : (x > y ? 1 : 0);
    });
    return {
      resumo: resumo,
      snapshotEm: iso(rec.cookiesSnapshotEm),
      descartados: rec.cookiesDescartados || 0,
      lista: lista
    };
  }

  function area(a) {
    if (!a) return null;
    return {
      disponivel: !!a.disponivel,
      erro: a.erro || '',
      chaves: a.chaves || 0,
      bytes: a.bytes || 0,
      amostra: (a.amostra || []).slice()
    };
  }

  function storage(rec) {
    var lista = [];
    rec.storage.forEach(function (st) {
      lista.push({
        origem: st.origem,
        dominio: st.dominio,
        terceiraParte: !!st.dominio && st.dominio !== rec.pageDomain,
        topo: st.topo,
        frames: st.frames.size,
        coletas: st.coletas,
        momento: st.momento || '',
        localStorage: area(st.localStorage),
        sessionStorage: area(st.sessionStorage),
        picoBytesLocal: st.picoBytesLocal,
        picoBytesSessao: st.picoBytesSessao,
        indexedDB: {
          bancos: arr(st.bancosIndexedDB),
          viaHook: !!st.indexedDBViaHook,
          erro: st.indexedDB ? st.indexedDB.erro || '' : ''
        },
        documentCookie: st.documentCookie ? {
          quantidade: st.documentCookie.quantidade || 0,
          nomes: (st.documentCookie.nomes || []).slice()
        } : null
      });
    });
    lista.sort(function (a, b) {
      if (a.topo !== b.topo) return a.topo ? -1 : 1;
      if (a.terceiraParte !== b.terceiraParte) return a.terceiraParte ? 1 : -1;
      return a.origem < b.origem ? -1 : 1;
    });
    return lista;
  }

  function fingerprint(rec) {
    var vetores = [];
    rec.fingerprint.vectors.forEach(function (v) {
      vetores.push({
        vetor: v.vetor,
        terceiraParte: v.terceiraParte,
        frames: v.frames.size,
        scripts: arr(v.scripts.values())
      });
    });
    return {
      canvasFingerprint: rec.fingerprint.canvas.some(function (c) { return c.fingerprint; }),
      canvas: rec.fingerprint.canvas.map(function (c) {
        return Object.assign({}, c, { ts: iso(c.ts) });
      }),
      vetores: vetores
    };
  }

  function bloqueio(rec) {
    var porDominio = [];
    if (rec.blocked && rec.blocked.byDomain) {
      rec.blocked.byDomain.forEach(function (n, d) { porDominio.push({ dominio: d, bloqueadas: n }); });
    }
    porDominio.sort(function (a, b) { return b.bloqueadas - a.bloqueadas; });
    return {
      total: rec.blocked ? rec.blocked.count : 0,
      porDominio: porDominio,
      lista: PL.blocklist && PL.blocklist.estado ? PL.blocklist.estado() : null
    };
  }

  // ------------------------------------------------------------ relatorio

  /**
   * Relatorio da aba. completo = true inclui o requestLog (para conferir
   * contra o HAR exportado do DevTools) e a lista de redirecionamentos.
   */
  function monta(rec, completo) {
    if (!rec) return null;
    var score = PL.score ? PL.score.calcula(rec) : null;
    var r = {
      ferramenta: 'PrivacyLens',
      versao: PL.VERSION,
      geradoEm: iso(Date.now()),
      pagina: {
        url: rec.pageUrl,
        dominio: rec.pageDomain,
        inicioCarregamento: iso(rec.startedAt),
        cookieStoreId: rec.cookieStoreId || null,
        navegacao: rec.navegacao || null,
        usuarioInteragiu: !!rec.usuarioInteragiu
      },
      score: score,
      requisicoes: {
        total: rec.requests.total,
        primeiraParte: rec.requests.firstParty,
        terceiraParte: rec.requests.thirdParty,
        erros: rec.requests.erros || 0,
        dominiosTerceiros: rec.thirdParties.size,
        logDescartadas: rec.requestLogDescartadas || 0
      },
      terceiros: terceiros(rec),
      cookies: cookies(rec),
      storage: storage(rec),
      fingerprint: fingerprint(rec),
      rastreamento: {
        resumo: PL.tracking ? PL.tracking.resumo(rec) : null,
        sync: rec.sync.slice(),
        bounce: rec.bounce.slice(),
        decoracao: rec.decoration.slice()
      },
      hijack: {
        resumo: PL.hijack ? PL.hijack.resumo(rec) : null,
        indicios: rec.hijack.slice()
      },
      bloqueio: bloqueio(rec),
      erros: PL.errors.map(function (e) { return { em: iso(e.ts), mensagem: e.mensagem }; })
    };
    if (completo) {
      r.redirecionamentos = rec.redirects.map(function (x) { return Object.assign({}, x, { ts: iso(x.ts) }); });
      r.requestLog = rec.requestLog.slice(-LOG_EXPORTADO_LIMITE).map(function (e) {
        return Object.assign({}, e, { ts: iso(e.ts) });
      });
    }
    // garante que tudo e JSON puro (Map/Set esquecidos viram {} e sao notados)
    return JSON.parse(JSON.stringify(r));
  }

  function nomeDoArquivo(rec) {
    var d = new Date();
    function dois(n) { return (n < 10 ? '0' : '') + n; }
    var carimbo = d.getFullYear() + dois(d.getMonth() + 1) + dois(d.getDate()) + '-' +
      dois(d.getHours()) + dois(d.getMinutes()) + dois(d.getSeconds());
    var dominio = String(rec.pageDomain || 'pagina').replace(/[^a-z0-9.-]/gi, '_');
    return 'privacylens_' + dominio + '_' + carimbo + '.json';
  }

  /** Baixa o relatorio completo. Feito no background: o popup fecha ao baixar. */
  function exporta(rec) {
    var json = JSON.stringify(monta(rec, true), null, 2);
    var url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    var arquivo = nomeDoArquivo(rec);
    // Promise.resolve().then: um erro de schema sincrono tambem libera o blob
    return Promise.resolve().then(function () {
      return browser.downloads.download({
        url: url,
        filename: arquivo,
        saveAs: false,
        incognito: rec.cookieStoreId === 'firefox-private'
      });
    }).then(function (id) {
      // libera o blob quando o download termina (ou em 1 min, no pior caso)
      var liberado = false;
      function libera() {
        if (liberado) return;
        liberado = true;
        URL.revokeObjectURL(url);
        browser.downloads.onChanged.removeListener(aoMudar);
      }
      function aoMudar(delta) {
        if (delta.id === id && delta.state && delta.state.current !== 'in_progress') libera();
      }
      browser.downloads.onChanged.addListener(aoMudar);
      setTimeout(libera, 60000);
      return { ok: true, arquivo: arquivo };
    }, function (e) {
      URL.revokeObjectURL(url);
      PL.warn('falha ao exportar o relatorio:', e);
      return { ok: false, erro: String(e && e.message || e) };
    });
  }

  function onRelatorio(msg, sender) {
    if (!daExtensao(sender)) return undefined;
    var rec = PL.state.get(msg.tabId);
    return Promise.resolve().then(function () {
      return rec ? monta(rec, false) : null;
    }).catch(function (e) {
      PL.warn('falha ao montar o relatorio:', e);
      return { erroRelatorio: String(e && e.message || e) };
    });
  }

  function onExportar(msg, sender) {
    if (!daExtensao(sender)) return undefined;
    var rec = PL.state.get(msg.tabId);
    if (!rec) return Promise.resolve({ ok: false, erro: 'Nenhum dado para esta aba. Recarregue a pagina.' });
    return Promise.resolve().then(function () { return exporta(rec); }).catch(function (e) {
      PL.warn('falha ao exportar o relatorio:', e);
      return { ok: false, erro: String(e && e.message || e) };
    });
  }

  PL.report = {
    monta: monta,
    exporta: exporta,

    /** Registra os tratadores de mensagem. Chamado por background/main.js. */
    register: function () {
      PL.onMensagem('relatorio', onRelatorio);
      PL.onMensagem('exportar', onExportar);
    }
  };
})();
