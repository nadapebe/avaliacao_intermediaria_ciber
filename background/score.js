'use strict';

/**
 * Pontuacao de privacidade da pagina (metodologia completa em METODOLOGIA.md).
 *
 * Escala de 0 a 100, onde 100 = melhor privacidade. Parte de 100 e subtrai
 * uma penalidade por criterio; os pesos somam exatamente 100, entao a
 * penalidade maxima zera o score.
 *
 *   Criterio                                   Peso  Calculo
 *   Dominios de 3a parte contatados             15   min(15, 3*log2(1+n))
 *   Cookies de 3a parte persistentes            20   min(20, 4*n)
 *   Cookies de 1a parte persistentes > 90 dias   5   min(5, 1*n)
 *   Storage HTML5 de 3a parte (em iframe)       10   min(10, 3*n)
 *   Volume de localStorage de 1a parte           5   min(5, bytes/50 KB)
 *   Canvas fingerprinting                       15   binario
 *   Cookie sync / bounce tracking               15   8 por sync distinto, +15 com bounce, teto 15
 *   Indicios de hijacking / hook                10   5 por indicio, teto 10
 *   Session recording / keylogging               5   binario
 *
 * Classificacao: A 80-100, B 60-79, C 40-59, D 20-39, E abaixo de 20.
 *
 * O objeto de score guarda, para cada criterio, o valor observado, a
 * penalidade aplicada, a formula e a justificativa; o popup e o relatorio
 * exibem essa quebra.
 */

var PL = window.PL || (window.PL = {});

(function () {
  var KB50 = 50 * 1024;

  // severidades de hijacking que contam no score (as "baixa" sao informativas)
  var SEVERIDADES_PENALIZADAS = ['alta', 'media'];
  // tipos de indicio que tem criterio proprio (session recording/keylogging)
  var TIPOS_SESSAO = ['keylogging', 'sessionRecording'];

  function arredonda(x) {
    return Math.round(x * 10) / 10;
  }

  function nota(valor) {
    if (valor >= 80) return 'A';
    if (valor >= 60) return 'B';
    if (valor >= 40) return 'C';
    if (valor >= 20) return 'D';
    return 'E';
  }

  function lista(arr, max) {
    arr = arr || [];
    var r = arr.slice(0, max || 5).join(', ');
    return arr.length > (max || 5) ? r + ' e mais ' + (arr.length - (max || 5)) : r;
  }

  // ------------------------------------------------------------ observacoes

  /**
   * Dominios de terceira parte efetivamente contatados. Nao contam aqueles
   * cujas requisicoes foram TODAS canceladas, pela lista de bloqueio do
   * PrivacyLens ou pelo Enhanced Tracking Protection do Firefox: nenhum dado
   * chegou a eles.
   */
  function terceirosContatados(rec) {
    var out = [];
    rec.thirdParties.forEach(function (st, dominio) {
      var bloqueadas = rec.blocked && rec.blocked.byDomain ? (rec.blocked.byDomain.get(dominio) || 0) : 0;
      bloqueadas += st.bloqueadasFirefox || 0;
      if (st.requisicoes > bloqueadas) out.push(dominio);
    });
    return out;
  }

  /** Cookies injetados e de fato armazenados (os rejeitados pelo Firefox nao contam). */
  function cookiesValidos(rec, filtro) {
    var out = [];
    rec.cookies.forEach(function (c) {
      if (!c.injetado || c.removido || c.armazenado === false) return;
      if (filtro(c)) out.push(c);
    });
    return out;
  }

  function temDados(area) {
    return !!area && (area.chaves > 0);
  }

  /** Origens de iframe de 3a parte que gravaram algo no armazenamento HTML5. */
  function storageTerceiros(rec) {
    var out = [];
    rec.storage.forEach(function (st) {
      if (!st.dominio || st.dominio === rec.pageDomain) return;
      var idb = st.bancosIndexedDB && st.bancosIndexedDB.size > 0;
      if (temDados(st.localStorage) || temDados(st.sessionStorage) || idb) out.push(st.origem);
    });
    return out;
  }

  /** Bytes de localStorage das origens de 1a parte (pico observado). */
  function bytesLocalPrimeira(rec) {
    var total = 0;
    rec.storage.forEach(function (st) {
      if (st.dominio && st.dominio === rec.pageDomain) total += st.picoBytesLocal || 0;
    });
    return total;
  }

  /**
   * Sinais informativos para a comparacao com o Blacklight (sem peso no
   * score), reconhecidos pelas mesmas regras do blacklight-collector:
   *   - Facebook Pixel: requisicao ao Facebook com o parametro "ev" do pixel
   *     (na pratica facebook.com/tr?ev=...), exceto o evento "Microdata";
   *   - Google Analytics "Remarketing Audiences": URL de stats.g.doubleclick
   *     com um ID de propriedade (UA-, G- ou AW-). O endpoint
   *     google.*\/ads/ga-audiences e uma adicao do PrivacyLens.
   * Requisicoes que falharam (ex.: bloqueadas pelo Firefox) nao contam: o
   * evento nunca chegou ao servidor.
   */
  function sinaisBlacklight(rec) {
    var fb = false;
    var ga = false;
    rec.requestLog.forEach(function (e) {
      if (e.erro) return;
      var u = e.url || '';
      if (/^https?:\/\/([^\/]*\.)?facebook\.(com|net)\//i.test(u) && /[?&]ev=/.test(u) &&
          !/[?&]ev=Microdata(&|$)/.test(u)) fb = true;
      if ((/^https?:\/\/stats\.g\.doubleclick\.net\//i.test(u) && /(UA|G|AW)-/.test(u)) ||
          /^https?:\/\/(www\.)?google\.[a-z.]+\/ads\/ga-audiences/i.test(u)) ga = true;
    });
    return { facebookPixel: fb, googleRemarketing: ga };
  }

  // ------------------------------------------------------------ calculo

  /**
   * Calcula o score da aba. Atualiza antes as analises de cookie sync/bounce
   * (tracking.js) e de hijacking (hijack.js), que dependem de todo o
   * carregamento. Guarda o resultado em rec.score e o devolve.
   */
  function calcula(rec) {
    if (!rec) return null;
    if (PL.cookies) PL.cookies.resumo(rec); // reclassifica pelo dominio atual
    if (PL.tracking) PL.tracking.analisa(rec);
    if (PL.hijack) PL.hijack.analisa(rec);

    var criterios = [];
    function criterio(id, nome, peso, observado, detalhe, penalidade, formula, justificativa) {
      criterios.push({
        id: id,
        nome: nome,
        peso: peso,
        observado: observado,
        detalhe: detalhe,
        penalidade: arredonda(Math.max(0, Math.min(peso, penalidade))),
        formula: formula,
        justificativa: justificativa
      });
    }

    // 1. dominios de terceira parte
    var terceiros = terceirosContatados(rec);
    var n1 = terceiros.length;
    criterio('terceiros', 'Domínios de 3ª parte contatados', 15, n1,
      n1 ? lista(terceiros, 8) : 'nenhum',
      3 * Math.log2(1 + n1),
      'min(15, 3 * log2(1 + n))',
      'Superfície de exposição: cada terceiro recebe IP, User-Agent e a página visitada. ' +
      'Escala logarítmica porque o primeiro terceiro pesa muito mais que o trigésimo ' +
      '(a penalidade atinge o teto em 31 terceiros).');

    // 2. cookies de terceira parte persistentes
    var c3p = cookiesValidos(rec, function (c) { return c.terceiraParte && c.persistente; });
    criterio('cookies3p', 'Cookies de 3ª parte persistentes', 20, c3p.length,
      c3p.length ? lista(c3p.map(function (c) { return c.nome + ' (' + c.dominioRegistravel + ')'; })) : 'nenhum',
      4 * c3p.length,
      'min(20, 4 * n)',
      'Identificador estável entre sites: o mecanismo clássico de rastreamento.');

    // 3. cookies de primeira parte de longa duracao
    var c1p = cookiesValidos(rec, function (c) { return !c.terceiraParte && c.persistente && c.longoPrazo; });
    criterio('cookies1pLongos', 'Cookies de 1ª parte persistentes > 90 dias', 5, c1p.length,
      c1p.length ? lista(c1p.map(function (c) { return c.nome + ' (' + Math.round(c.duracaoDias) + ' dias)'; })) : 'nenhum',
      1 * c1p.length,
      'min(5, 1 * n)',
      'Cookie de primeira parte de longa duração funciona como identificador do visitante ' +
      '(ex.: _ga, _fbp), lido por scripts de terceiros embutidos na página.');

    // 4. armazenamento HTML5 de terceira parte
    var s3p = storageTerceiros(rec);
    criterio('storage3p', 'Storage HTML5 de 3ª parte (em iframe)', 10, s3p.length,
      s3p.length ? lista(s3p) : 'nenhum',
      3 * s3p.length,
      'min(10, 3 * n)',
      'Persistência fora do ciclo de vida do cookie: sobrevive à limpeza de cookies ' +
      'e não é controlada pelas preferências de cookie.');

    // 5. volume de localStorage de primeira parte
    var bytes = bytesLocalPrimeira(rec);
    criterio('localStorage1p', 'Volume de localStorage de 1ª parte', 5, bytes,
      Math.round(bytes / 1024) + ' KB',
      bytes / KB50,
      'min(5, bytes / 50 KB)',
      'Indicador de supercookie ou de estado excessivo guardado no navegador do usuário.');

    // 6. canvas fingerprinting
    var canvasFp = rec.fingerprint.canvas.filter(function (c) { return c.fingerprint; });
    var scriptsCanvas = [];
    canvasFp.forEach(function (c) {
      var s = c.dominioScript || c.script;
      if (scriptsCanvas.indexOf(s) < 0) scriptsCanvas.push(s);
    });
    criterio('canvas', 'Canvas fingerprinting', 15, canvasFp.length > 0,
      canvasFp.length ? 'por ' + lista(scriptsCanvas) : 'não detectado',
      canvasFp.length ? 15 : 0,
      'binário: 15 se detectado',
      'Identificação sem consentimento e sem estado: não é removida limpando cookies ' +
      'e o usuário não consegue evitar.');

    // 7. cookie sync e bounce tracking
    var pares = [];
    var ids = 0;
    rec.sync.forEach(function (s) {
      if (s.tipo === 'sincronismo') {
        var par = s.de + ' -> ' + s.para;
        if (pares.indexOf(par) < 0) pares.push(par);
      } else if (s.tipo === 'idCompartilhado') {
        ids++;
      }
    });
    var bounces = rec.bounce.filter(function (b) { return b.bounce; });
    var nSync = pares.length + ids;
    var detalheSync = [];
    if (pares.length) detalheSync.push(pares.length + ' sync (' + lista(pares, 3) + ')');
    if (ids) detalheSync.push(ids + ' ID compartilhado entre terceiros');
    if (bounces.length) {
      detalheSync.push('bounce via ' + lista(bounces.map(function (b) { return b.via; }), 3));
    }
    criterio('sync', 'Cookie sync / bounce tracking', 15,
      { sincronismos: nSync, bounce: bounces.length > 0 },
      detalheSync.length ? detalheSync.join('; ') : 'não detectado',
      8 * nSync + (bounces.length ? 15 : 0),
      '8 por sync distinto, +15 se houver bounce, teto 15',
      'Une as identidades do usuário em domínios diferentes, anulando o isolamento ' +
      'de cookies por site.');

    // 8. hijacking / hook
    var hijack = rec.hijack.filter(function (i) {
      return TIPOS_SESSAO.indexOf(i.tipo) < 0 && SEVERIDADES_PENALIZADAS.indexOf(i.severidade) >= 0;
    });
    criterio('hijack', 'Indícios de hijacking / hook', 10, hijack.length,
      hijack.length ? lista(hijack.map(function (i) { return i.tipo + ' (' + i.dominio + ', ' + i.severidade + ')'; })) : 'nenhum',
      5 * hijack.length,
      '5 por indício de severidade média ou alta, teto 10',
      'Vai além do rastreamento: é controle do navegador (canal de comando, ' +
      'interceptação de chamadas).');

    // 9. session recording / keylogging
    var sessao = rec.hijack.filter(function (i) { return TIPOS_SESSAO.indexOf(i.tipo) >= 0; });
    criterio('sessao', 'Session recording / keylogging', 5, sessao.length > 0,
      sessao.length ? lista(sessao.map(function (i) { return i.tipo + ' (' + i.dominio + ')'; })) : 'não detectado',
      sessao.length ? 5 : 0,
      'binário: 5 se detectado',
      'Captura o conteúdo digitado e os movimentos do usuário, não só metadados.');

    var totalPenalidades = 0;
    criterios.forEach(function (c) { totalPenalidades += c.penalidade; });
    var valor = Math.max(0, Math.min(100, Math.round(100 - totalPenalidades)));

    rec.score = {
      valor: valor,
      nota: nota(valor),
      totalPenalidades: arredonda(totalPenalidades),
      criterios: criterios,
      informativo: sinaisBlacklight(rec),
      calculadoEm: Date.now()
    };
    return rec.score;
  }

  PL.score = {
    calcula: calcula,
    nota: nota
  };
})();
