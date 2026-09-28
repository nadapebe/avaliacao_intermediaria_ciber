'use strict';

/**
 * PrivacyLens - popup: relatorio por pagina.
 *
 * Pede ao background o relatorio da aba ativa ({tipo: 'relatorio'}) e o
 * exibe em abas. Todo texto vindo das paginas (dominios, nomes de cookies,
 * URLs de scripts) entra no DOM por textContent, nunca como HTML: um site
 * malicioso nao consegue injetar codigo na interface da extensao.
 */

(function () {
  var ABAS = [
    ['resumo', 'Resumo'],
    ['terceiros', 'Terceiros'],
    ['cookies', 'Cookies'],
    ['storage', 'Storage'],
    ['fingerprint', 'Fingerprint'],
    ['rastreio', 'Rastreio'],
    ['hijacking', 'Hijacking'],
    ['bloqueio', 'Bloqueio'],
    ['erros', 'Erros']
  ];
  var LINHAS_LIMITE = 300;

  var estado = { tabId: null, relatorio: null, aba: 'resumo', bloqueio: null, avisoBloqueio: '', rascunho: '' };

  // popup.html?tabId=N: o relatorio aberto numa aba normal, em altura livre
  // (usado para prints de pagina inteira no relatorio do trabalho)
  var tabIdDaUrl = null;
  try {
    var p = new URLSearchParams(location.search).get('tabId');
    if (p !== null && /^\d+$/.test(p)) tabIdDaUrl = Number(p);
  } catch (e) { /* sem parametros */ }
  if (tabIdDaUrl !== null) document.documentElement.classList.add('em-aba');

  try {
    var salva = localStorage.getItem('privacylens.aba');
    if (salva && ABAS.some(function (a) { return a[0] === salva; })) estado.aba = salva;
  } catch (e) { /* sem armazenamento local */ }

  // ------------------------------------------------------------ utilidades de DOM

  /**
   * Cria um elemento. "filhos" pode ser texto, elemento ou lista deles;
   * texto sempre vira no de texto (nunca HTML).
   */
  function el(tag, attrs, filhos) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'class') e.className = v;
        else if (k === 'title') e.title = String(v);
        else e.setAttribute(k, String(v));
      });
    }
    adiciona(e, filhos);
    return e;
  }

  function adiciona(pai, filhos) {
    if (filhos === undefined || filhos === null || filhos === false) return;
    if (Array.isArray(filhos)) {
      filhos.forEach(function (f) { adiciona(pai, f); });
      return;
    }
    if (typeof filhos === 'object' && filhos.nodeType) pai.appendChild(filhos);
    else pai.appendChild(document.createTextNode(String(filhos)));
  }

  function selo(texto, tipo, titulo) {
    return el('span', { class: 'selo' + (tipo ? ' ' + tipo : ''), title: titulo }, texto);
  }

  function vazio(texto) {
    return el('p', { class: 'vazio' }, texto);
  }

  function tabela(cabecalho, linhas, classe) {
    var thead = el('thead', null, el('tr', null, cabecalho.map(function (c) {
      return typeof c === 'string' ? el('th', null, c) : el('th', { class: c.classe }, c.texto);
    })));
    var tbody = el('tbody', null, linhas.slice(0, LINHAS_LIMITE).map(function (cels) {
      return el('tr', null, cels.map(function (c) {
        if (c && typeof c === 'object' && !c.nodeType && !Array.isArray(c)) {
          return el('td', { class: c.classe, title: c.titulo }, c.conteudo);
        }
        return el('td', null, c);
      }));
    }));
    var t = el('table', { class: classe }, [thead, tbody]);
    if (linhas.length > LINHAS_LIMITE) {
      return [t, el('p', { class: 'suave pequeno' },
        'Mostrando ' + LINHAS_LIMITE + ' de ' + linhas.length + '. O JSON exportado tem a lista completa.')];
    }
    return t;
  }

  function num(v) {
    return { classe: 'num', conteudo: String(v) };
  }

  function kb(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    return (Math.round(bytes / 102.4) / 10) + ' KB';
  }

  function hora(isoTexto) {
    if (!isoTexto) return '';
    try { return new Date(isoTexto).toLocaleTimeString(); } catch (e) { return isoTexto; }
  }

  function simNao(v) {
    return v ? el('span', { class: 'marcado' }, '✓') : el('span', { class: 'desmarcado' }, '–');
  }

  function curto(url, max) {
    url = String(url || '');
    max = max || 60;
    return url.length > max ? url.slice(0, max - 1) + '…' : url;
  }

  // ------------------------------------------------------------ carregamento

  function status(texto) {
    var s = document.getElementById('status');
    s.textContent = texto || '';
    s.title = texto || ''; // texto completo ao passar o mouse (o nome do arquivo pode ser cortado)
  }

  function carregar() {
    status('atualizando...');
    var aba = tabIdDaUrl !== null ? Promise.resolve([{ id: tabIdDaUrl }]) :
      browser.tabs.query({ active: true, currentWindow: true });
    return aba.then(function (tabs) {
      if (!tabs.length) throw new Error('nenhuma aba ativa');
      estado.tabId = tabs[0].id;
      return browser.runtime.sendMessage({ tipo: 'relatorio', tabId: estado.tabId });
    }).then(function (r) {
      estado.relatorio = r || null;
      return mensagemBloqueio({ acao: 'estado' });
    }).then(function () {
      renderiza();
      var r = estado.relatorio;
      status(r && !r.erroRelatorio ? 'atualizado às ' + new Date().toLocaleTimeString() : '');
    }).catch(function (e) {
      estado.relatorio = null;
      renderiza();
      status('erro: ' + (e && e.message || e));
    });
  }

  /** Envia uma acao da lista de bloqueio e guarda o estado devolvido. */
  function mensagemBloqueio(msg) {
    msg.tipo = 'bloqueio';
    return browser.runtime.sendMessage(msg).then(function (res) {
      if (res && res.estado) estado.bloqueio = res.estado;
      estado.avisoBloqueio = res && !res.ok ? res.erro : '';
      return res;
    }).catch(function (e) {
      estado.avisoBloqueio = 'falha: ' + (e && e.message || e);
    });
  }

  /** Acao na lista feita pela interface: atualiza a tela e avisa para recarregar. */
  function acaoBloqueio(msg, aviso) {
    return mensagemBloqueio(msg).then(function (res) {
      if (res && res.ok && aviso) status(aviso);
      renderiza();
    });
  }

  function naLista(dominio) {
    var b = estado.bloqueio;
    return !!b && b.regras.some(function (x) { return x.padrao === dominio && x.ativo; });
  }

  function abrirEmAba() {
    if (estado.tabId === null) return;
    browser.tabs.create({ url: browser.runtime.getURL('popup/popup.html?tabId=' + estado.tabId) })
      .catch(function (e) { status('falha: ' + (e && e.message || e)); });
  }

  function exportar() {
    var botao = document.getElementById('exportar');
    if (estado.tabId === null) {
      status('aba ainda nao identificada; clique em Atualizar');
      return;
    }
    botao.disabled = true;
    status('exportando...');
    browser.runtime.sendMessage({ tipo: 'exportar', tabId: estado.tabId }).then(function (res) {
      botao.disabled = false;
      if (res && res.ok) status('salvo em Downloads: ' + res.arquivo);
      else status('falha: ' + (res && res.erro || 'sem resposta'));
    }).catch(function (e) {
      botao.disabled = false;
      status('falha: ' + (e && e.message || e));
    });
  }

  // ------------------------------------------------------------ abas

  function contadorDaAba(id, r) {
    if (!r) return null;
    switch (id) {
      case 'terceiros': return r.terceiros.length;
      case 'cookies': return r.cookies.resumo ? r.cookies.resumo.injetados : r.cookies.lista.length;
      case 'storage': return r.storage.length;
      case 'fingerprint': return r.fingerprint.canvas.length + r.fingerprint.vetores.length;
      case 'rastreio': return r.rastreamento.sync.length + r.rastreamento.bounce.length + r.rastreamento.decoracao.length;
      case 'hijacking': return r.hijack.indicios.length;
      case 'bloqueio': return r.bloqueio ? r.bloqueio.total : 0;
      case 'erros': return r.erros.length;
      default: return null;
    }
  }

  function renderizaAbas() {
    var nav = document.getElementById('abas');
    nav.textContent = '';
    var r = estado.relatorio && !estado.relatorio.erroRelatorio ? estado.relatorio : null;
    ABAS.forEach(function (a) {
      var n = contadorDaAba(a[0], r);
      var b = el('button', {
        type: 'button',
        role: 'tab',
        'aria-selected': estado.aba === a[0] ? 'true' : 'false'
      }, [a[1], n ? el('span', { class: 'contador' }, String(n)) : null]);
      b.addEventListener('click', function () {
        estado.aba = a[0];
        try { localStorage.setItem('privacylens.aba', a[0]); } catch (e) { /* */ }
        renderiza();
      });
      nav.appendChild(b);
    });
  }

  function renderiza() {
    renderizaAbas();
    var r = estado.relatorio;
    var alvo = document.getElementById('conteudo');
    alvo.textContent = '';
    var pagina = document.getElementById('pagina');

    if ((!r || r.erroRelatorio) && estado.aba === 'bloqueio') {
      pagina.textContent = 'sem dados desta aba';
      adiciona(alvo, secaoBloqueio(null));
      return;
    }

    if (!r || r.erroRelatorio) {
      pagina.textContent = 'sem dados';
      adiciona(alvo, [
        el('h2', null, 'Nenhum dado para esta aba'),
        el('p', null, r && r.erroRelatorio ?
          'Falha ao montar o relatório: ' + r.erroRelatorio :
          'O PrivacyLens só observa páginas web (http/https) carregadas depois dele. ' +
          'Recarregue a página (F5) e abra o popup de novo.')
      ]);
      return;
    }

    pagina.textContent = (r.pagina.dominio || '') + ' — ' + curto(r.pagina.url, 70);
    var secoes = {
      resumo: secaoResumo,
      terceiros: secaoTerceiros,
      cookies: secaoCookies,
      storage: secaoStorage,
      fingerprint: secaoFingerprint,
      rastreio: secaoRastreio,
      hijacking: secaoHijacking,
      bloqueio: secaoBloqueio,
      erros: secaoErros
    };
    adiciona(alvo, (secoes[estado.aba] || secaoResumo)(r));
  }

  // ------------------------------------------------------------ Resumo

  var CORES = { A: '#1a7f37', B: '#4c8a1e', C: '#9a6700', D: '#c2410c', E: '#cf222e' };

  /** Medidor semicircular do score (SVG montado por API de DOM). */
  function medidor(valor, nota) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '120');
    svg.setAttribute('height', '68');
    svg.setAttribute('viewBox', '0 0 120 68');
    var comprimento = Math.PI * 50;
    function arco(cor, fracao) {
      var p = document.createElementNS(ns, 'path');
      p.setAttribute('d', 'M10 60 A50 50 0 0 1 110 60');
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', cor);
      p.setAttribute('stroke-width', '10');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-dasharray', (comprimento * fracao) + ' ' + comprimento);
      return p;
    }
    svg.appendChild(arco('#e3e8ef', 1));
    svg.appendChild(arco(CORES[nota] || '#999', Math.max(0.001, valor / 100)));
    var t = document.createElementNS(ns, 'text');
    t.setAttribute('x', '60');
    t.setAttribute('y', '58');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-size', '22');
    t.setAttribute('font-weight', '700');
    t.setAttribute('fill', CORES[nota] || '#333');
    t.textContent = nota;
    svg.appendChild(t);
    return svg;
  }

  function secaoResumo(r) {
    var s = r.score;
    if (!s) return vazio('Score indisponível.');
    var c = r.cookies.resumo || {};
    var porId = {};
    s.criterios.forEach(function (x) { porId[x.id] = x; });
    var obsSync = porId.sync ? porId.sync.observado : { sincronismos: 0, bounce: false };

    var numeros = el('div', { class: 'numeros' }, [
      el('div', { class: 'numero' }, [el('b', null, String(porId.terceiros ? porId.terceiros.observado : r.terceiros.length)), el('span', null, 'domínios de 3ª parte contatados')]),
      el('div', { class: 'numero' }, [el('b', null, String(c.injetados || 0)), el('span', null, 'cookies injetados (' + (c.terceiraParte || 0) + ' de 3ª)')]),
      el('div', { class: 'numero' }, [el('b', null, String(r.storage.length)), el('span', null, 'origens com storage')]),
      el('div', { class: 'numero' }, [el('b', null, r.fingerprint.canvasFingerprint ? 'Sim' : 'Não'), el('span', null, 'canvas fingerprint')]),
      el('div', { class: 'numero' }, [el('b', null, String(obsSync.sincronismos) + ' / ' + (obsSync.bounce ? 'sim' : 'não')), el('span', null, 'cookie sync / bounce')]),
      el('div', { class: 'numero' }, [el('b', null, String(porId.hijack ? porId.hijack.observado : 0) + (porId.sessao && porId.sessao.observado ? ' + sessão' : '')), el('span', null, 'indícios de hijacking' + (porId.sessao && porId.sessao.observado ? ' / gravação' : ''))])
    ]);

    var linhas = s.criterios.map(function (x) {
      var largura = x.peso ? Math.round(x.penalidade / x.peso * 100) : 0;
      return [
        el('div', { class: 'criterio' }, [
          el('div', null, el('strong', null, x.nome)),
          el('div', { class: 'suave pequeno quebra' }, x.detalhe),
          el('div', { class: 'barra' }, el('i', { style: 'width:' + largura + '%' })),
          el('div', { class: 'justificativa' }, x.formula + ' — ' + x.justificativa)
        ]),
        num((x.penalidade ? '−' + x.penalidade : '0') + ' / ' + x.peso)
      ];
    });

    var info = s.informativo || {};
    return [
      el('div', { class: 'medidor' }, [
        medidor(s.valor, s.nota),
        el('div', null, [
          el('div', { class: 'valor-score' }, [s.valor + '/100 ', el('span', { class: 'nota nota-' + s.nota }, 'nota ' + s.nota)]),
          el('div', { class: 'legenda' }, '100 = melhor privacidade. Penalidades somadas: ' + s.totalPenalidades),
          el('div', { class: 'legenda' }, 'Carregamento iniciado às ' + hora(r.pagina.inicioCarregamento))
        ])
      ]),
      numeros,
      el('h2', null, 'Como a nota foi calculada'),
      tabela(['Critério', { texto: 'Penalidade', classe: 'num' }], linhas),
      el('p', { class: 'pequeno' }, [
        'Sinais para comparação com o Blacklight: ',
        selo('Facebook Pixel: ' + (info.facebookPixel ? 'sim' : 'não'), info.facebookPixel ? 'alerta' : 'ok'),
        selo('GA Remarketing: ' + (info.googleRemarketing ? 'sim' : 'não'), info.googleRemarketing ? 'alerta' : 'ok')
      ]),
      el('p', { class: 'suave pequeno' }, 'Metodologia completa: METODOLOGIA.md no repositório.')
    ];
  }

  // ------------------------------------------------------------ Terceiros

  function secaoTerceiros(r) {
    var q = r.requisicoes;
    var bloqueados = r.terceiros.filter(function (t) {
      return t.requisicoes <= t.bloqueadasFirefox + t.bloqueadasPlugin;
    }).length;
    var cab = el('p', null, r.terceiros.length + ' domínios de terceira parte (' +
      (r.terceiros.length - bloqueados) + ' contatados, ' + bloqueados + ' totalmente bloqueados); ' +
      q.terceiraParte + ' de ' + q.total + ' requisições foram para terceiros.');
    if (!r.terceiros.length) return [cab, vazio('Nenhuma conexão a terceiros.')];
    var linhas = r.terceiros.map(function (t) {
      var selos = [];
      if (t.enviouCookie) selos.push(selo('envia Cookie', 'alerta', 'O navegador enviou o header Cookie a este domínio'));
      if (t.recebeuSetCookie) selos.push(selo('Set-Cookie', 'alerta', 'O domínio gravou cookie por header'));
      if (t.bloqueadasFirefox) selos.push(selo('ETP bloqueou ' + t.bloqueadasFirefox, 'ok', 'Requisições canceladas pelo Enhanced Tracking Protection do Firefox'));
      if (t.bloqueadasPlugin) selos.push(selo('bloqueado ' + t.bloqueadasPlugin, 'ok', 'Requisições canceladas pela lista de bloqueio do PrivacyLens'));
      t.classificacaoFirefox.forEach(function (c) { selos.push(selo(c, 'info', 'Classificação do Firefox')); });
      var botao;
      if (naLista(t.dominio)) {
        botao = selo('na lista', 'ok', 'Já está na lista de bloqueio (vale a partir do próximo carregamento)');
      } else {
        botao = el('button', { type: 'button', class: 'bloquear', title: 'Adiciona ' + t.dominio + ' à lista de bloqueio' }, 'Bloquear');
        botao.addEventListener('click', function () {
          acaoBloqueio({ acao: 'adicionar', padrao: t.dominio },
            t.dominio + ' bloqueado. Recarregue a página para medir de novo.');
        });
      }
      return [
        el('div', null, [el('strong', { class: 'quebra' }, t.dominio), el('div', { class: 'suave pequeno quebra', title: t.exemplos.join('\n') }, curto(t.exemplos[0], 55))]),
        num(t.requisicoes),
        el('span', { class: 'pequeno' }, t.tipos.join(', ')),
        selos,
        botao
      ];
    });
    return [cab, tabela(['Domínio', { texto: 'Req.', classe: 'num' }, 'Tipos', 'Sinais', ''], linhas, 'terceiros')];
  }

  // ------------------------------------------------------------ Cookies

  function secaoCookies(r) {
    var c = r.cookies.resumo || { matriz: { primeira: {}, terceira: {} } };
    var m = c.matriz;
    var matriz = tabela(['', 'Sessão', 'Persistente', 'Total'], [
      ['1ª parte', String(m.primeira.sessao || 0), String(m.primeira.persistente || 0), el('strong', null, String(c.primeiraParte || 0))],
      ['3ª parte', String(m.terceira.sessao || 0), String(m.terceira.persistente || 0), el('strong', null, String(c.terceiraParte || 0))]
    ], 'matriz');
    var selos = el('p', null, [
      selo(c.injetados + ' injetados'),
      selo(c.viaHttp + ' por header'),
      selo(c.viaJavascript + ' por JavaScript'),
      selo(c.longoPrazo + ' > 90 dias', c.longoPrazo ? 'alerta' : ''),
      selo(c.aptoCrossSite + ' SameSite=None;Secure', c.aptoCrossSite ? 'alerta' : ''),
      selo(c.httpOnly + ' HttpOnly'),
      selo(c.particionados + ' particionados', 'info', 'Isolados pelo Total Cookie Protection do Firefox'),
      selo(c.naoArmazenados + ' rejeitados pelo Firefox', c.naoArmazenados ? 'ok' : ''),
      selo(c.preexistentes + ' pré-existentes', '', 'Já existiam antes desta visita: não contam como injetados')
    ]);

    var linhas = r.cookies.lista.filter(function (x) { return !x.removido; }).map(function (x) {
      var flags = [];
      if (x.httpOnly) flags.push(selo('HttpOnly'));
      if (x.secure) flags.push(selo('Secure'));
      flags.push(selo('SameSite=' + (x.sameSiteDeclarado || x.sameSite), x.aptoCrossSite ? 'alerta' : ''));
      if (x.particionado) flags.push(selo('particionado', 'info'));
      if (x.armazenado === false) flags.push(selo('rejeitado', 'ok'));
      if (!x.injetado) flags.push(selo('pré-existente'));
      if (x.viaRedirect) flags.push(selo('via redirect', 'alerta'));
      return [
        el('div', null, [el('strong', { class: 'quebra' }, x.nome), el('div', { class: 'suave pequeno quebra' }, x.dominio)]),
        x.terceiraParte ? selo('3ª', 'alerta') : selo('1ª'),
        x.persistente ? el('span', { class: x.longoPrazo ? 'nao' : '' }, x.duracaoDias + ' dias') : el('span', { class: 'suave' }, 'sessão'),
        el('span', null, [x.injetado ? selo(x.origem === 'javascript' ? 'JS' : 'header') : null, flags])
      ];
    });
    return [
      el('h2', null, 'Cookies injetados neste carregamento'),
      matriz,
      selos,
      el('h2', null, 'Lista'),
      linhas.length ? tabela(['Nome / domínio', 'Parte', 'Duração', 'Origem e atributos'], linhas) : vazio('Nenhum cookie.')
    ];
  }

  // ------------------------------------------------------------ Storage

  function descreveArea(nome, a) {
    if (!a) return el('div', { class: 'suave pequeno' }, nome + ': não coletado');
    if (a.erro) return el('div', { class: 'pequeno' }, [nome + ': ', selo('bloqueado (' + a.erro + ')', 'ok')]);
    return el('div', { class: 'pequeno' }, [
      el('strong', null, nome + ': '),
      a.chaves + (a.chaves === 1 ? ' chave, ' : ' chaves, ') + kb(a.bytes),
      a.amostra.length ? el('div', { class: 'suave quebra' }, a.amostra.join(', ')) : null
    ]);
  }

  function secaoStorage(r) {
    if (!r.storage.length) return vazio('Nenhum frame reportou armazenamento ainda.');
    return [el('p', null, 'Armazenamento HTML5 por origem de frame (inclui iframes de terceiros).')].concat(
      r.storage.map(function (s) {
        return el('div', { class: 'cartao' }, [
          el('div', { class: 'cabeca' }, [
            el('span', { class: 'quebra' }, s.origem),
            el('span', null, [
              s.topo ? selo('página') : selo('iframe'),
              s.terceiraParte ? selo('3ª parte', 'alerta') : selo('1ª parte')
            ])
          ]),
          descreveArea('localStorage', s.localStorage),
          descreveArea('sessionStorage', s.sessionStorage),
          el('div', { class: 'pequeno' }, [
            el('strong', null, 'IndexedDB: '),
            s.indexedDB.bancos.length ? s.indexedDB.bancos.join(', ') : 'nenhum banco',
            s.indexedDB.viaHook ? selo('visto no open()', 'info') : null
          ]),
          s.documentCookie ? el('div', { class: 'pequeno' }, [
            el('strong', null, 'document.cookie: '),
            s.documentCookie.quantidade + ' cookies visíveis ao JavaScript'
          ]) : null,
          el('div', { class: 'suave pequeno' }, s.frames + ' frame(s), última coleta: ' + s.momento)
        ]);
      })
    );
  }

  // ------------------------------------------------------------ Fingerprint

  function secaoFingerprint(r) {
    var f = r.fingerprint;
    var fps = f.canvas.filter(function (c) { return c.fingerprint; });
    var titulo = fps.length ?
      el('p', null, [selo('CANVAS FINGERPRINTING DETECTADO', 'perigo'), ' por ',
        fps.map(function (c) { return c.dominioScript || curto(c.script, 40); }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', ')]) :
      el('p', null, [selo('canvas fingerprinting não detectado', 'ok')]);

    var leituras = f.canvas.map(function (c) {
      var k = c.criterios;
      return el('div', { class: 'cartao ' + (c.fingerprint ? 'alta' : 'baixa') }, [
        el('div', { class: 'cabeca' }, [
          el('span', { class: 'quebra' }, curto(c.script, 60)),
          c.fingerprint ? selo('fingerprint', 'perigo') : selo('leitura comum')
        ]),
        el('div', { class: 'pequeno' }, c.metodo + ' em canvas ' + c.largura + '×' + c.altura +
          ', ' + c.caracteresDistintos + ' caracteres distintos, ' + c.cores + ' cor(es)' +
          (c.amostraTexto ? ' — texto: "' + c.amostraTexto + '"' : '')),
        el('div', { class: 'criterios-canvas' }, [
          el('span', null, [simNao(k.tamanho), ' ≥16×16']),
          el('span', null, [simNao(k.texto), ' texto']),
          el('span', null, [simNao(k.leitura), ' leitura ≥16×16']),
          el('span', null, [simNao(k.oculto), ' oculto'])
        ]),
        c.terceiraParte ? selo('script de 3ª parte', 'alerta') : null
      ]);
    });

    var vetores = f.vetores.map(function (v) {
      return [
        el('strong', null, v.vetor),
        v.terceiraParte ? selo('3ª parte', 'alerta') : selo('1ª parte'),
        el('div', { class: 'pequeno quebra' }, v.scripts.map(function (s) {
          return el('div', { title: s.script }, curto(s.script, 60));
        }))
      ];
    });

    return [
      el('h2', null, 'Canvas'),
      titulo,
      leituras.length ? leituras : vazio('Nenhuma leitura de canvas.'),
      el('h2', null, 'Outros vetores de fingerprinting'),
      vetores.length ? tabela(['Vetor', 'Parte', 'Scripts'], vetores) : vazio('Nenhum vetor observado.')
    ];
  }

  // ------------------------------------------------------------ Rastreio

  function secaoRastreio(r) {
    var t = r.rastreamento;
    var sync = t.sync.map(function (s) {
      if (s.tipo === 'idCompartilhado') {
        return el('div', { class: 'cartao media' }, [
          el('div', { class: 'cabeca' }, [el('span', null, 'ID compartilhado entre terceiros'), selo('sync', 'alerta')]),
          el('div', { class: 'pequeno quebra' }, (s.dominios || []).join(', ') + ' — parâmetro ' + (s.parametros || []).join(', ') + ', valor ' + s.valorAmostra)
        ]);
      }
      var vaz = s.tipo === 'vazamentoPrimeiraParte';
      return el('div', { class: 'cartao ' + (vaz || s.bloqueada ? 'baixa' : 'media') }, [
        el('div', { class: 'cabeca' }, [
          el('span', { class: 'quebra' }, s.de + ' → ' + s.para),
          el('span', null, [
            vaz ? selo('ID de 1ª parte vazado') : selo('cookie sync', 'alerta'),
            s.bloqueada ? selo('requisição bloqueada', 'ok', 'A requisição foi cancelada: o identificador não chegou ao destino') : null
          ])
        ]),
        el('div', { class: 'pequeno quebra' }, 'cookie "' + s.cookie + '" no parâmetro "' + s.parametro + '" (' + s.valorAmostra + ')'),
        el('div', { class: 'suave pequeno quebra' }, curto(s.url, 90))
      ]);
    });

    var bounce = t.bounce.map(function (b) {
      return el('div', { class: 'cartao ' + (b.bounce ? 'alta' : 'baixa') }, [
        el('div', { class: 'cabeca' }, [
          el('span', { class: 'quebra' }, (b.de || '(origem desconhecida)') + ' → ' + b.via + ' → ' + b.para),
          b.bounce ? selo('bounce tracking', 'perigo') : selo('redirecionamento')
        ]),
        el('div', { class: 'pequeno' }, 'redirecionamento no ' + (b.tipo === 'cliente' ? 'cliente (JavaScript)' : 'servidor (3xx)') +
          ', permanência em ' + b.via + ': ' + b.permanenciaMs + ' ms' +
          (b.setCookie ? ', gravou cookie' : '') + (b.cookieEnviado ? ', recebeu cookie de visita anterior' : ''))
      ]);
    });

    var deco = t.decoracao.map(function (d) {
      return [el('strong', null, d.parametro), d.onde === 'navegacao' ? selo('navegação', 'alerta') : selo('requisição'), el('span', { class: 'pequeno quebra' }, d.dominio + ' — ' + d.valorAmostra)];
    });

    return [
      el('h2', null, 'Cookie sync'),
      sync.length ? sync : vazio('Nenhum valor de cookie encontrado em URLs de terceiros.'),
      el('h2', null, 'Bounce tracking'),
      bounce.length ? bounce : vazio('Nenhuma cadeia de redirecionamento nesta navegação.'),
      el('h2', null, 'Link decoration'),
      deco.length ? tabela(['Parâmetro', 'Onde', 'Domínio / valor'], deco) : vazio('Nenhum parâmetro de rastreamento nas URLs.')
    ];
  }

  // ------------------------------------------------------------ Hijacking

  var NOMES_INDICIO = {
    websocket: 'WebSocket para terceiro',
    polling: 'Polling persistente',
    scriptInjetado: 'Script injetado após o load',
    hook: 'Hook de API nativa',
    keylogging: 'Keylogging',
    sessionRecording: 'Gravação de sessão',
    beef: 'Assinatura BeEF',
    hookJs: 'Script hook.js'
  };

  function secaoHijacking(r) {
    var lista = r.hijack.indicios.slice().sort(function (a, b) {
      var ordem = { alta: 0, media: 1, baixa: 2 };
      return ordem[a.severidade] - ordem[b.severidade];
    });
    if (!lista.length) return [el('p', null, [selo('nenhum indício de hijacking ou hook', 'ok')])];
    return [el('p', { class: 'suave pequeno' }, 'Indícios de severidade baixa são informativos e não entram na nota.')].concat(
      lista.map(function (i) {
        var tipoSelo = i.severidade === 'alta' ? 'perigo' : (i.severidade === 'media' ? 'alerta' : '');
        return el('div', { class: 'cartao ' + i.severidade }, [
          el('div', { class: 'cabeca' }, [
            el('span', null, (NOMES_INDICIO[i.tipo] || i.tipo) + (i.dominio ? ' — ' + i.dominio : '')),
            selo(i.severidade, tipoSelo)
          ]),
          el('div', { class: 'pequeno quebra' }, i.evidencia),
          i.scripts && i.scripts.length ? el('div', { class: 'suave pequeno quebra' }, 'script: ' +
            i.scripts.map(function (s) { return typeof s === 'string' ? s : s.script; }).join(', ')) : null
        ]);
      })
    );
  }

  // ------------------------------------------------------------ Bloqueio

  function secaoBloqueio(r) {
    var b = estado.bloqueio;
    if (!b) {
      return estado.avisoBloqueio ?
        el('p', { class: 'pequeno nao' }, 'Não foi possível ler a lista de bloqueio: ' + estado.avisoBloqueio) :
        vazio('Carregando a lista de bloqueio...');
    }

    var geral = el('input', { type: 'checkbox', id: 'bloqueioGeral' });
    geral.checked = b.ativo;
    geral.addEventListener('change', function () {
      acaoBloqueio({ acao: 'geral', ativo: geral.checked },
        geral.checked ? 'Bloqueio ligado.' : 'Bloqueio desligado: o PrivacyLens só observa.');
    });

    var campo = el('input', { type: 'text', id: 'novoPadrao', placeholder: 'ex.: doubleclick.net ou *.hotjar.com', class: 'campo' });
    campo.value = estado.rascunho; // o texto digitado sobrevive a uma regra invalida
    campo.addEventListener('input', function () { estado.rascunho = campo.value; });
    var adicionar = el('button', { type: 'button', class: 'bloquear' }, 'Adicionar');
    function adicionarPadrao() {
      var texto = campo.value;
      if (!texto.trim()) return;
      estado.rascunho = texto;
      mensagemBloqueio({ acao: 'adicionar', padrao: texto }).then(function (res) {
        if (res && res.ok) {
          estado.rascunho = '';
          status('Regra adicionada. Vale para as próximas requisições; recarregue a página para medir de novo.');
        } else {
          status('');
        }
        renderiza();
        var novo = document.getElementById('novoPadrao');
        if (novo) novo.focus();
      });
    }
    adicionar.addEventListener('click', adicionarPadrao);
    campo.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') adicionarPadrao(); });

    var regras = b.regras.map(function (x) {
      var liga = el('input', { type: 'checkbox', title: 'Ligar/desligar esta regra' });
      liga.checked = x.ativo;
      liga.addEventListener('change', function () {
        acaoBloqueio({ acao: 'alternar', padrao: x.padrao, ativo: liga.checked });
      });
      var remover = el('button', { type: 'button', class: 'remover', title: 'Remover da lista' }, '×');
      remover.addEventListener('click', function () {
        acaoBloqueio({ acao: 'remover', padrao: x.padrao }, x.padrao + ' removido da lista.');
      });
      return [liga, el('strong', { class: 'quebra' + (x.ativo ? '' : ' suave') }, x.padrao), num(x.bloqueiosSessao), remover];
    });

    var nestaAba = r && r.bloqueio ? r.bloqueio : null;
    var porDominio = nestaAba ? nestaAba.porDominio.map(function (d) {
      return [el('span', { class: 'quebra' }, d.dominio), num(d.bloqueadas)];
    }) : [];

    return [
      el('p', { class: 'suave pequeno' }, 'Por padrão o PrivacyLens só observa. As regras abaixo cancelam as requisições ' +
        'que casarem (exceto a navegação principal). Um domínio vale também para os subdomínios; use * como curinga.'),
      el('label', { class: 'linha' }, [geral, ' Bloqueio ', el('strong', null, b.ativo ? 'ligado' : 'desligado')]),
      el('div', { class: 'linha' }, [campo, adicionar]),
      estado.avisoBloqueio ? el('p', { class: 'pequeno nao' }, estado.avisoBloqueio) : null,
      el('h2', null, 'Regras (' + b.regras.length + ')'),
      regras.length ? tabela(['', 'Domínio ou padrão', { texto: 'Bloqueios*', classe: 'num' }, ''], regras) :
        vazio('Lista vazia. Adicione aqui ou use "Bloquear" na aba Terceiros.'),
      el('p', { class: 'suave pequeno' }, '* desde que o Firefox abriu. Total nesta sessão: ' + b.totalSessao + '.'),
      el('h2', null, 'Bloqueado nesta página'),
      nestaAba ? (porDominio.length ? [el('p', null, nestaAba.total + ' requisições canceladas.'),
        tabela(['Domínio', { texto: 'Requisições', classe: 'num' }], porDominio)] :
        vazio('Nenhuma requisição desta página foi bloqueada.')) :
        vazio('Sem dados desta aba.')
    ];
  }

  // ------------------------------------------------------------ Erros

  function secaoErros(r) {
    if (!r.erros.length) return [el('p', null, [selo('nenhum erro de execução capturado', 'ok')])];
    return [el('p', { class: 'suave pequeno' }, 'Falhas capturadas nos módulos do PrivacyLens, de todas as abas (mais recentes por último).')].concat(
      r.erros.map(function (e) {
        var linhas = String(e.mensagem || '').split('\n');
        return el('div', { class: 'cartao baixa' }, [
          el('div', { class: 'suave pequeno' }, hora(e.em)),
          el('div', { class: 'pequeno quebra' }, linhas[0]),
          linhas.length > 1 ? el('details', { class: 'pilha' }, [
            el('summary', null, 'detalhes'),
            el('pre', null, linhas.slice(1).join('\n'))
          ]) : null
        ]);
      })
    );
  }

  // ------------------------------------------------------------ inicio

  document.getElementById('atualizar').addEventListener('click', carregar);
  document.getElementById('exportar').addEventListener('click', exportar);
  var botaoAba = document.getElementById('emAba');
  if (tabIdDaUrl !== null) botaoAba.hidden = true;
  else botaoAba.addEventListener('click', abrirEmAba);
  document.getElementById('conteudo').appendChild(el('p', { class: 'vazio' }, 'Carregando relatório...'));
  renderizaAbas();
  carregar();
})();
