'use strict';

/**
 * PrivacyLens - script de pagina (world MAIN).
 *
 * Declarado em manifest.json como content script com "world": "MAIN",
 * run_at document_start, all_frames e match_about_blank (suportado em
 * Manifest V2 a partir do Firefox 128). Por isso roda no contexto da propria
 * pagina, de forma sincrona e ANTES de qualquer script do site, sem depender
 * de <script src> (que seria assincrono, bloqueado pelo CSP da pagina e
 * exporia o UUID da extensao).
 *
 * Instrumenta as APIs usadas em fingerprinting e comunica o que observou ao
 * content script (content/content.js) por CustomEvent "__privacylens" com um
 * texto JSON em "detail".
 *
 * Criterio de canvas fingerprinting, exigindo TODAS as condicoes:
 *   1. o canvas tem pelo menos 16x16 px;
 *   2. houve escrita de texto (fillText/strokeText) com pelo menos 10
 *      caracteres distintos OU com 2 ou mais cores;
 *   3. a imagem foi lida de volta (toDataURL/toBlob, ou getImageData de uma
 *      area de pelo menos 16x16);
 *   4. o canvas nao estava exibido ao usuario (fora do DOM, display:none,
 *      visibility:hidden, opacidade 0, tamanho zero ou fora da tela).
 * As condicoes 1 a 3 sao as de Englehardt & Narayanan (2016), "Online
 * Tracking: A 1-million-site Measurement and Analysis", adotadas pelo
 * Blacklight. A condicao 4 e uma adicao do PrivacyLens: substitui a exclusao
 * do artigo (scripts que chamam save/restore/addEventListener) como filtro de
 * falsos positivos, pois um canvas que o usuario ve (grafico, jogo) nao e
 * fingerprinting.
 *
 * O proprio PrivacyLens faz hooking: cada funcao instrumentada fica no mapa
 * interno PROPRIAS (wrapper -> original). Function.prototype.toString devolve
 * o texto da original para esses wrappers, para que a pagina nao mude de
 * comportamento por detectar a instrumentacao; a deteccao de hooks do site
 * (background/hijack.js) exclui estas funcoes. Limitacao documentada em METODOLOGIA.md.
 *
 * Robustez contra a pagina: todo nativo usado depois do carregamento (Set,
 * WeakMap, metodos de String, JSON, eventos) e salvo aqui, antes de qualquer
 * script do site, e chamado por Reflect.apply; os eventos sao objetos sem
 * prototipo, imunes a Object.prototype.toJSON.
 */

(function () {
  // ------------------------------------------------------------ nativos salvos
  var _apply = Reflect.apply;
  var _construct = Reflect.construct;
  var _defineProperty = Object.defineProperty;
  var _getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  var _create = Object.create;
  var _hasOwn = Object.prototype.hasOwnProperty;
  var _stringify = JSON.stringify;
  var _String = String;
  var _Number = Number;
  var _abs = Math.abs;
  var _Error = Error;
  var _stackGet = (_getOwnPropertyDescriptor(Error.prototype, 'stack') || {}).get;
  var _dispatch = EventTarget.prototype.dispatchEvent;
  var _addEventListener = EventTarget.prototype.addEventListener;
  var _CustomEvent = CustomEvent;
  var _Proxy = Proxy;
  var _toString = Function.prototype.toString;
  var _getComputedStyle = window.getComputedStyle;
  var _getBoundingClientRect = Element.prototype.getBoundingClientRect;
  var _isConnected = (_getOwnPropertyDescriptor(Node.prototype, 'isConnected') || {}).get;

  var _Set = Set;
  var _setHas = Set.prototype.has;
  var _setAdd = Set.prototype.add;
  var _setSize = _getOwnPropertyDescriptor(Set.prototype, 'size').get;
  var _WeakMap = WeakMap;
  var _wmGet = WeakMap.prototype.get;
  var _wmHas = WeakMap.prototype.has;
  var _wmSet = WeakMap.prototype.set;
  var _indexOf = String.prototype.indexOf;
  var _lastIndexOf = String.prototype.lastIndexOf;
  var _slice = String.prototype.slice;
  var _split = String.prototype.split;
  var _charAt = String.prototype.charAt;
  var _charCodeAt = String.prototype.charCodeAt;
  var _toLowerCase = String.prototype.toLowerCase;
  var _trim = String.prototype.trim;
  var _setTimeout = setTimeout;
  var _getPrototypeOf = Object.getPrototypeOf;
  var _nodeName = (_getOwnPropertyDescriptor(Node.prototype, 'nodeName') || {}).get;

  var win = window;
  var doc = document;
  var paginaUrl = _String(location.href);

  var EVENTO_PONTE = '__privacylens';
  var FILA_LIMITE = 500;
  var EVENTOS_LIMITE = 500;
  var LEITURAS_POR_CANVAS = 20;
  var CHAMADAS_COM_PILHA = 200;
  var MIN_FP = 16;

  // atalhos para os nativos salvos
  function setHas(s, v) { return _apply(_setHas, s, [v]); }
  function setAdd(s, v) { _apply(_setAdd, s, [v]); }
  function setSize(s) { return _apply(_setSize, s, []); }
  function wmGet(m, k) { return _apply(_wmGet, m, [k]); }
  function wmHas(m, k) { return _apply(_wmHas, m, [k]); }
  function wmSet(m, k, v) { _apply(_wmSet, m, [k, v]); }
  function sIndexOf(s, t) { return _apply(_indexOf, s, [t]); }
  function sSlice(s, a, b) { return _apply(_slice, s, b === undefined ? [a] : [a, b]); }

  /** Objeto sem prototipo (imune a Object.prototype.toJSON e afins). */
  function objeto(campos) {
    var o = _create(null);
    for (var k in campos) {
      if (_apply(_hasOwn, campos, [k])) o[k] = campos[k];
    }
    return o;
  }

  // wrapper -> original: funcoes instrumentadas pelo proprio PrivacyLens
  var PROPRIAS = new _WeakMap();

  // ------------------------------------------------------------ ponte

  var fila = [];
  var pronto = false;
  var enviados = new _Set();
  var totalEventos = 0;

  function dispara(texto) {
    try {
      _apply(_dispatch, doc, [new _CustomEvent(EVENTO_PONTE, objeto({ detail: texto }))]);
    } catch (e) { /* documento descartado */ }
  }

  /** Envia um evento ao content script (ou guarda ate a ponte ficar pronta). */
  function emite(ev, chave, prioritario) {
    if (chave !== undefined) {
      if (setHas(enviados, chave)) return;
      setAdd(enviados, chave);
    }
    // eventos de hook nao disputam o limite (ja sao poucos pela deduplicacao)
    if (!prioritario) {
      if (totalEventos >= EVENTOS_LIMITE) return;
      totalEventos++;
    }
    var texto;
    try { texto = _stringify(ev); } catch (e) { return; }
    if (!pronto) {
      if (fila.length < FILA_LIMITE) fila[fila.length] = texto;
      return;
    }
    dispara(texto);
  }

  function limiteAtingido() {
    return totalEventos >= EVENTOS_LIMITE;
  }

  // escuta na fase de captura do window, registrada antes de qualquer script
  // do site: nenhum listener da pagina consegue interromper o aviso antes
  _apply(_addEventListener, win, [EVENTO_PONTE + ':pronto', function () {
    if (pronto) return;
    pronto = true;
    var pendentes = fila;
    fila = [];
    for (var i = 0; i < pendentes.length; i++) dispara(pendentes[i]);
  }, true]);
  // a ponte pode ter nascido antes deste script: pede um novo "pronto"
  try {
    _apply(_dispatch, doc, [new _CustomEvent(EVENTO_PONTE + ':ping')]);
  } catch (e) { /* sem documento */ }

  // ------------------------------------------------------------ atribuicao

  function pilhaAtual() {
    try {
      var erro = new _Error();
      return _String(_stackGet ? _apply(_stackGet, erro, []) : erro.stack);
    } catch (e) {
      return '';
    }
  }

  /** Remove sufixos ":linha:coluna" (ou ":linha") sem usar RegExp. */
  function semLinhaColuna(s) {
    for (var voltas = 0; voltas < 2; voltas++) {
      var i = _apply(_lastIndexOf, s, [':']);
      if (i < 0 || i === s.length - 1) return s;
      for (var j = i + 1; j < s.length; j++) {
        var c = _apply(_charCodeAt, s, [j]);
        if (c < 48 || c > 57) return s;
      }
      s = sSlice(s, 0, i);
    }
    return s;
  }

  /**
   * URL de uma linha da pilha do Firefox: "funcao@url:linha:coluna"; codigo
   * em eval/Function aparece como "url line N > eval:..." e o prefixo
   * "async*" marca quadros assincronos.
   */
  function urlDaLinha(linha) {
    var at = sIndexOf(linha, '@');
    if (at < 0) return '';
    var resto = sSlice(linha, at + 1);
    var ev = sIndexOf(resto, ' line ');
    if (ev >= 0) resto = sSlice(resto, 0, ev);
    return semLinhaColuna(resto);
  }

  // nome de arquivo deste script na pilha. No world MAIN o Firefox o oculta
  // como "<anonymous code>" (e nao moz-extension://...), justamente para nao
  // expor a extensao a pagina; as linhas com esse nome sao puladas
  var PROPRIO = urlDaLinha(_apply(_split, pilhaAtual(), ['\n'])[0] || '');

  /**
   * URL do script do site que chamou a API instrumentada, extraida de
   * new Error().stack: o primeiro quadro que nao seja deste script nem de
   * outra extensao. Sem URL de script: codigo inline da propria pagina.
   */
  function scriptDeOrigem(pularPrimeiro) {
    var linhas = _apply(_split, pilhaAtual(), ['\n']);
    var primeiro = '';
    for (var i = 0; i < linhas.length; i++) {
      var url = urlDaLinha(linhas[i]);
      if (!url || url === PROPRIO) continue;
      if (sSlice(_apply(_toLowerCase, url, []), 0, 14) === 'moz-extension:') continue;
      if (url.length > 512) url = sSlice(url, 0, 512);
      // pularPrimeiro: o primeiro script da pilha e um intermediario (ex.:
      // biblioteca de monitoramento que envolveu a API); o autor real da
      // chamada e o proximo script diferente dele, se houver
      if (!pularPrimeiro) return url;
      if (!primeiro) { primeiro = url; continue; }
      if (url !== primeiro) return url;
    }
    return primeiro || paginaUrl;
  }

  // ------------------------------------------------------------ instrumentacao

  function copiaMetadados(w, original) {
    try { _defineProperty(w, 'name', { value: original.name, configurable: true }); } catch (e) { /* */ }
    try { _defineProperty(w, 'length', { value: original.length, configurable: true }); } catch (e) { /* */ }
  }

  /**
   * Substitui o metodo obj[prop]. "antes" recebe (thisArg, args) e roda antes
   * da original; falhas nele nunca afetam a pagina. O wrapper e criado como
   * metodo (sem prototype e nao construtivel), como os nativos.
   */
  function envolveMetodo(obj, prop, antes) {
    try {
      if (!obj) return;
      var desc = _getOwnPropertyDescriptor(obj, prop);
      if (!desc || typeof desc.value !== 'function' || !desc.configurable) return;
      var original = desc.value;
      var w = ({
        [prop]() {
          try { antes(this, arguments); } catch (e) { /* nunca quebra a pagina */ }
          return _apply(original, this, arguments);
        }
      })[prop];
      copiaMetadados(w, original);
      wmSet(PROPRIAS, w, original);
      _defineProperty(obj, prop, {
        value: w,
        writable: desc.writable,
        enumerable: desc.enumerable,
        configurable: desc.configurable
      });
    } catch (e) { /* segue sem este hook */ }
  }

  /** Substitui o getter obj[prop]; "aoLer" roda antes do getter original. */
  function envolveGetter(obj, prop, aoLer) {
    try {
      if (!obj) return;
      var desc = _getOwnPropertyDescriptor(obj, prop);
      if (!desc || typeof desc.get !== 'function' || !desc.configurable) return;
      var original = desc.get;
      var novo = _getOwnPropertyDescriptor({
        get [prop]() {
          try { aoLer(this); } catch (e) { /* nunca quebra a pagina */ }
          return _apply(original, this, []);
        }
      }, prop).get;
      wmSet(PROPRIAS, novo, original);
      _defineProperty(obj, prop, {
        get: novo,
        set: desc.set,
        enumerable: desc.enumerable,
        configurable: desc.configurable
      });
    } catch (e) { /* segue sem este hook */ }
  }

  /** Substitui um construtor global por um Proxy que observa o "new". */
  function envolveConstrutor(nome, aoCriar) {
    try {
      var desc = _getOwnPropertyDescriptor(win, nome);
      if (!desc || typeof desc.value !== 'function' || !desc.configurable) return;
      var original = desc.value;
      var p = new _Proxy(original, {
        construct: function (alvo, args, novoAlvo) {
          try { aoCriar(args); } catch (e) { /* nunca quebra a pagina */ }
          return _construct(alvo, args, novoAlvo === p ? alvo : novoAlvo);
        }
      });
      wmSet(PROPRIAS, p, original);
      _defineProperty(win, nome, {
        value: p,
        writable: desc.writable,
        enumerable: desc.enumerable,
        configurable: desc.configurable
      });
      // mantem X.prototype.constructor === X para o construtor visivel
      try {
        _defineProperty(original.prototype, 'constructor', {
          value: p, writable: true, enumerable: false, configurable: true
        });
      } catch (e) { /* */ }
    } catch (e) { /* segue sem este hook */ }
  }

  /**
   * Objeto da cadeia de prototipos que define obj[prop] (no Firefox, fetch e
   * open ficam no proprio window; XMLHttpRequest.prototype.open no prototipo).
   */
  function donoDe(obj, prop) {
    var o = obj;
    for (var i = 0; o && i < 10; i++) {
      if (_getOwnPropertyDescriptor(o, prop)) return o;
      o = _getPrototypeOf(o);
    }
    return null;
  }

  /** Substitui getter E setter de obj[prop]; "aoUsar" roda antes de ambos. */
  function envolveAcessor(obj, prop, aoUsar) {
    try {
      if (!obj) return;
      var desc = _getOwnPropertyDescriptor(obj, prop);
      if (!desc || typeof desc.get !== 'function' || !desc.configurable) return;
      var get = desc.get;
      var set = desc.set;
      var modelo = {
        get [prop]() {
          try { aoUsar(); } catch (e) { /* nunca quebra a pagina */ }
          return _apply(get, this, []);
        },
        set [prop](v) {
          try { aoUsar(); } catch (e) { /* nunca quebra a pagina */ }
          if (set) _apply(set, this, [v]);
        }
      };
      var novoDesc = _getOwnPropertyDescriptor(modelo, prop);
      wmSet(PROPRIAS, novoDesc.get, get);
      if (set) wmSet(PROPRIAS, novoDesc.set, set);
      _defineProperty(obj, prop, {
        get: novoDesc.get,
        set: set ? novoDesc.set : undefined,
        enumerable: desc.enumerable,
        configurable: desc.configurable
      });
    } catch (e) { /* segue sem este hook */ }
  }

  // Function.prototype.toString devolve o texto da funcao original para os
  // wrappers do PrivacyLens (a pagina continua vendo "[native code]")
  (function () {
    try {
      var desc = _getOwnPropertyDescriptor(Function.prototype, 'toString');
      if (!desc || !desc.configurable) return;
      var novo = ({
        toString() {
          var alvo = wmHas(PROPRIAS, this) ? wmGet(PROPRIAS, this) : this;
          return _apply(_toString, alvo, arguments);
        }
      }).toString;
      wmSet(PROPRIAS, novo, _toString);
      _defineProperty(Function.prototype, 'toString', {
        value: novo,
        writable: desc.writable,
        enumerable: desc.enumerable,
        configurable: desc.configurable
      });
    } catch (e) { /* */ }
  })();

  // ------------------------------------------------------------ canvas

  var canvasProto = win.HTMLCanvasElement && HTMLCanvasElement.prototype;
  var ctx2dProto = win.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
  var descLargura = canvasProto && _getOwnPropertyDescriptor(canvasProto, 'width');
  var descAltura = canvasProto && _getOwnPropertyDescriptor(canvasProto, 'height');
  var descCanvasDoCtx = ctx2dProto && _getOwnPropertyDescriptor(ctx2dProto, 'canvas');
  var descFillStyle = ctx2dProto && _getOwnPropertyDescriptor(ctx2dProto, 'fillStyle');
  var descStrokeStyle = ctx2dProto && _getOwnPropertyDescriptor(ctx2dProto, 'strokeStyle');
  var descFont = ctx2dProto && _getOwnPropertyDescriptor(ctx2dProto, 'font');

  function le(desc, obj, padrao) {
    try { return desc && desc.get ? _apply(desc.get, obj, []) : padrao; } catch (e) { return padrao; }
  }

  // canvas -> {caracteres, cores, amostra, leituras}
  var estados = new _WeakMap();

  function estadoDe(canvas) {
    var st = wmGet(estados, canvas);
    if (!st) {
      st = { caracteres: new _Set(), cores: new _Set(), amostra: '', leituras: 0 };
      wmSet(estados, canvas, st);
    }
    return st;
  }

  function registraTexto(ctx, texto, descCor) {
    var canvas = le(descCanvasDoCtx, ctx, null);
    if (!canvas) return;
    var st = estadoDe(canvas);
    texto = _String(texto);
    for (var i = 0; i < texto.length && setSize(st.caracteres) < 200; i++) {
      setAdd(st.caracteres, _apply(_charAt, texto, [i]));
    }
    if (setSize(st.cores) < 20) setAdd(st.cores, _String(le(descCor, ctx, '')));
    if (!st.amostra) st.amostra = sSlice(texto, 0, 32);
  }

  /** O canvas esta visivel ao usuario? */
  function exibido(canvas) {
    try {
      if (_isConnected && !_apply(_isConnected, canvas, [])) return false;
      var r = _apply(_getBoundingClientRect, canvas, []);
      if (!r || r.width === 0 || r.height === 0) return false;
      if (r.right <= 0 || r.bottom <= 0) return false;
      var cs = _apply(_getComputedStyle, win, [canvas]);
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Avalia uma leitura de canvas contra o criterio de fingerprinting. */
  function avaliaLeitura(canvas, metodo, larguraLida, alturaLida) {
    if (!canvas || limiteAtingido()) return;
    var st = estadoDe(canvas);
    st.leituras++;
    if (st.leituras > LEITURAS_POR_CANVAS) return;
    var largura = _Number(le(descLargura, canvas, 0)) || 0;
    var altura = _Number(le(descAltura, canvas, 0)) || 0;
    if (larguraLida === undefined) {
      larguraLida = largura;
      alturaLida = altura;
    }
    var criterios = objeto({
      tamanho: largura >= MIN_FP && altura >= MIN_FP,
      texto: setSize(st.caracteres) >= 10 || setSize(st.cores) >= 2,
      leitura: _abs(larguraLida) >= MIN_FP && _abs(alturaLida) >= MIN_FP,
      oculto: !exibido(canvas)
    });
    var fp = criterios.tamanho && criterios.texto && criterios.leitura && criterios.oculto;
    var script = scriptDeOrigem();
    emite(objeto({
      tipo: 'canvas',
      fingerprint: fp,
      script: script,
      metodo: metodo,
      largura: largura,
      altura: altura,
      caracteresDistintos: setSize(st.caracteres),
      cores: setSize(st.cores),
      amostraTexto: st.amostra,
      criterios: criterios
    }), 'canvas|' + fp + '|' + metodo + '|' + script);
  }

  envolveMetodo(ctx2dProto, 'fillText', function (ctx, args) {
    registraTexto(ctx, args[0], descFillStyle);
  });
  envolveMetodo(ctx2dProto, 'strokeText', function (ctx, args) {
    registraTexto(ctx, args[0], descStrokeStyle);
  });
  envolveMetodo(canvasProto, 'toDataURL', function (canvas) {
    avaliaLeitura(canvas, 'toDataURL');
  });
  envolveMetodo(canvasProto, 'toBlob', function (canvas) {
    avaliaLeitura(canvas, 'toBlob');
  });
  envolveMetodo(ctx2dProto, 'getImageData', function (ctx, args) {
    avaliaLeitura(le(descCanvasDoCtx, ctx, null), 'getImageData',
      _Number(args[2]) || 0, _Number(args[3]) || 0);
  });

  /**
   * Familia de uma declaracao "font" do canvas ("italic bold 12px/30px
   * Georgia, serif" -> "georgia, serif"): o que importa na enumeracao de
   * fontes e medir MUITAS FAMILIAS, e nao a mesma fonte em varios tamanhos.
   */
  function familiaDaFonte(font) {
    font = _String(font);
    var partes = _apply(_split, font, [' ']);
    var pos = 0;
    for (var i = 0; i < partes.length; i++) {
      var p = partes[i];
      var c = _apply(_charCodeAt, p, [0]);
      if ((c >= 48 && c <= 57) || c === 46) { // comeca com digito ou "."
        // so digitos ("600") e peso da fonte; o tamanho tem unidade ("12px")
        var soDigitos = true;
        for (var j = 0; j < p.length; j++) {
          var d = _apply(_charCodeAt, p, [j]);
          if (d < 48 || d > 57) { soDigitos = false; break; }
        }
        if (!soDigitos) {
          return _apply(_toLowerCase, _apply(_trim, sSlice(font, pos + p.length), []), []);
        }
      }
      pos += p.length + 1;
    }
    return _apply(_toLowerCase, font, []);
  }

  // enumeracao de fontes: medir texto com muitas familias diferentes
  var familiasMedidas = new _Set();
  var LIMITE_FONTES = 20;
  envolveMetodo(ctx2dProto, 'measureText', function (ctx) {
    if (setSize(familiasMedidas) >= LIMITE_FONTES) return;
    setAdd(familiasMedidas, familiaDaFonte(le(descFont, ctx, '')));
    if (setSize(familiasMedidas) === LIMITE_FONTES) {
      vetor('fontes', { familiasDistintas: LIMITE_FONTES });
    }
  });

  // ------------------------------------------------------------ outros vetores

  var chamadasPorVetor = _create(null);

  /** Registra o uso de um vetor de fingerprinting (1 evento por vetor e script). */
  function vetor(nome, extra) {
    if (limiteAtingido()) return;
    var n = chamadasPorVetor[nome] = (chamadasPorVetor[nome] || 0) + 1;
    if (n > CHAMADAS_COM_PILHA) return; // o custo da pilha so vale no inicio
    var script = scriptDeOrigem();
    var ev = objeto({ tipo: 'vetor', vetor: nome, script: script });
    if (extra) {
      for (var k in extra) {
        if (_apply(_hasOwn, extra, [k])) ev[k] = extra[k];
      }
    }
    emite(ev, 'vetor|' + nome + '|' + script);
  }

  // WebGL: renderizador/fabricante reais da GPU e varredura de parametros
  var UNMASKED_VENDOR = 0x9245;
  var UNMASKED_RENDERER = 0x9246;
  var parametrosWebgl = new _Set();
  function aoLerParametro(ctx, args) {
    var p = _Number(args[0]);
    if (p === UNMASKED_VENDOR || p === UNMASKED_RENDERER) {
      vetor('webgl_unmasked');
      return;
    }
    if (setSize(parametrosWebgl) < 20) {
      setAdd(parametrosWebgl, p);
      if (setSize(parametrosWebgl) === 20) vetor('webgl_parametros', { parametrosDistintos: 20 });
    }
  }
  envolveMetodo(win.WebGLRenderingContext && WebGLRenderingContext.prototype, 'getParameter', aoLerParametro);
  envolveMetodo(win.WebGL2RenderingContext && WebGL2RenderingContext.prototype, 'getParameter', aoLerParametro);

  // AudioContext: o fingerprint de audio usa OfflineAudioContext + oscilador
  envolveConstrutor('OfflineAudioContext', function () { vetor('audio', { api: 'OfflineAudioContext' }); });
  envolveMetodo(win.BaseAudioContext && BaseAudioContext.prototype, 'createOscillator', function () {
    vetor('audio', { api: 'createOscillator' });
  });
  envolveMetodo(win.BaseAudioContext && BaseAudioContext.prototype, 'createDynamicsCompressor', function () {
    vetor('audio', { api: 'createDynamicsCompressor' });
  });

  // WebRTC: pode revelar enderecos IP locais
  envolveConstrutor('RTCPeerConnection', function () { vetor('webrtc'); });

  // navigator e screen
  var navProto = win.Navigator && Navigator.prototype;
  ['hardwareConcurrency', 'plugins', 'languages', 'deviceMemory'].forEach(function (prop) {
    envolveGetter(navProto, prop, function () { vetor('navigator.' + prop); });
  });
  if (navProto && typeof navProto.getBattery === 'function') {
    envolveMetodo(navProto, 'getBattery', function () { vetor('battery'); });
  }
  var screenProto = win.Screen && Screen.prototype;
  ['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth'].forEach(function (prop) {
    envolveGetter(screenProto, prop, function () { vetor('screen', { propriedade: prop }); });
  });

  // ------------------------------------------------------------ hijacking e hook

  /*
   * APIs cujo hook pelo site e procurado. Cada uma recebe um wrapper leve do
   * PrivacyLens. Quando a troca de referencia e detectada, a proxima chamada
   * que passar pelo wrapper (vinda do hook do site, que repassa a chamada a
   * funcao original) revela na pilha o script responsavel.
   */
  var capturarOrigem = _create(null);

  function aoChamarApi(api) {
    if (!capturarOrigem[api]) return;
    capturarOrigem[api] = false;
    emite(objeto({ tipo: 'hookOrigem', api: api, script: scriptDeOrigem() }), 'hookOrigem|' + api, true);
  }

  var xhrProto = win.XMLHttpRequest && XMLHttpRequest.prototype;
  var historyProto = win.History && History.prototype;
  var docProto = win.Document && Document.prototype;
  var eventTargetProto = EventTarget.prototype;

  envolveMetodo(donoDe(win, 'fetch'), 'fetch', function () { aoChamarApi('fetch'); });
  envolveMetodo(xhrProto, 'open', function () { aoChamarApi('XMLHttpRequest.open'); });
  envolveMetodo(xhrProto, 'send', function () { aoChamarApi('XMLHttpRequest.send'); });
  envolveMetodo(navProto, 'sendBeacon', function () { aoChamarApi('navigator.sendBeacon'); });
  envolveMetodo(historyProto, 'pushState', function () { aoChamarApi('history.pushState'); });
  envolveMetodo(donoDe(win, 'open'), 'open', function () { aoChamarApi('window.open'); });
  envolveAcessor(docProto, 'cookie', function () { aoChamarApi('document.cookie'); });

  // WebSocket: indicio de canal persistente (com o script que o abriu)
  var websocketsVistos = new _Set();
  envolveConstrutor('WebSocket', function (args) {
    aoChamarApi('WebSocket');
    var url = sSlice(_String(args[0]), 0, 512);
    if (setHas(websocketsVistos, url) || limiteAtingido()) return;
    setAdd(websocketsVistos, url);
    emite(objeto({ tipo: 'websocket', url: url, script: scriptDeOrigem() }));
  });

  // listeners de teclado/digitacao/mouse: keylogging e gravacao de sessao
  var EVENTOS_MONITORADOS = new _Set(['keydown', 'keypress', 'keyup', 'input', 'mousemove']);
  var listenersPorTipo = _create(null);

  function descreveAlvo(alvo) {
    if (alvo === win) return 'window';
    if (alvo === doc) return 'document';
    try {
      return _apply(_toLowerCase, _String(_apply(_nodeName, alvo, [])), []);
    } catch (e) {
      return 'outro';
    }
  }

  envolveMetodo(eventTargetProto, 'addEventListener', function (alvo, args) {
    aoChamarApi('addEventListener');
    var tipo = args[0];
    if (typeof tipo !== 'string' || !setHas(EVENTOS_MONITORADOS, tipo)) return;
    var n = listenersPorTipo[tipo] = (listenersPorTipo[tipo] || 0) + 1;
    if (n > 300 || limiteAtingido()) return;
    // se outra biblioteca (Sentry, zone.js...) envolveu o addEventListener,
    // ela aparece como chamadora de todos os listeners: pula esse quadro
    var intermediario = false;
    try {
      var atual = _getOwnPropertyDescriptor(eventTargetProto, 'addEventListener');
      // envolvido no EventTarget.prototype, num prototipo intermediario
      // (ex.: Node.prototype) ou no proprio objeto
      intermediario = !atual || atual.value !== nossoAddEventListener ||
        alvo.addEventListener !== nossoAddEventListener;
    } catch (e) { /* */ }
    var script = scriptDeOrigem(intermediario);
    emite(objeto({ tipo: 'listener', evento: tipo, script: script, alvo: descreveAlvo(alvo) }),
      'listener|' + tipo + '|' + script);
  });

  var nossoAddEventListener = (_getOwnPropertyDescriptor(eventTargetProto, 'addEventListener') || {}).value;

  /*
   * Retrato das referencias, tirado DEPOIS das instrumentacoes do proprio
   * PrivacyLens (que ficam, assim, fora da deteccao). "instancia" e o objeto
   * onde um hook poderia sombrear a propriedade do prototipo.
   */
  var ALVOS = [
    { api: 'fetch', dono: donoDe(win, 'fetch'), prop: 'fetch' },
    { api: 'XMLHttpRequest', dono: donoDe(win, 'XMLHttpRequest'), prop: 'XMLHttpRequest' },
    { api: 'XMLHttpRequest.open', dono: xhrProto, prop: 'open' },
    { api: 'XMLHttpRequest.send', dono: xhrProto, prop: 'send' },
    { api: 'WebSocket', dono: donoDe(win, 'WebSocket'), prop: 'WebSocket' },
    { api: 'navigator.sendBeacon', dono: navProto, prop: 'sendBeacon', instancia: navigator },
    { api: 'addEventListener', dono: eventTargetProto, prop: 'addEventListener', instancia: doc },
    { api: 'history.pushState', dono: historyProto, prop: 'pushState', instancia: history },
    { api: 'window.open', dono: donoDe(win, 'open'), prop: 'open' },
    { api: 'document.cookie', dono: docProto, prop: 'cookie', instancia: doc },
    { api: 'Function.prototype.toString', dono: Function.prototype, prop: 'toString' }
  ];

  function leDescritor(alvo) {
    var d = alvo.dono ? _getOwnPropertyDescriptor(alvo.dono, alvo.prop) : null;
    return d ? { v: d.value, g: d.get, s: d.set } : null;
  }

  var retrato = [];
  for (var ia = 0; ia < ALVOS.length; ia++) retrato[ia] = leDescritor(ALVOS[ia]);

  function textoDaFuncao(fn) {
    try { return _String(_apply(_toString, fn, [])); } catch (e) { return ''; }
  }

  function comparaReferencias(momento) {
    for (var i = 0; i < ALVOS.length; i++) {
      var alvo = ALVOS[i];
      var antes = retrato[i];
      if (!antes) continue;
      var agora = leDescritor(alvo);
      var mudou = !agora || agora.v !== antes.v || agora.g !== antes.g || agora.s !== antes.s;
      var sombreado = false;
      if (alvo.instancia && alvo.instancia !== alvo.dono) {
        try { sombreado = !!_getOwnPropertyDescriptor(alvo.instancia, alvo.prop); } catch (e) { /* */ }
      }
      if (!mudou && !sombreado) continue;
      var fn = null;
      if (sombreado) {
        var ds = _getOwnPropertyDescriptor(alvo.instancia, alvo.prop);
        fn = ds && (ds.value || ds.get || ds.set);
      } else if (agora) {
        fn = agora.v !== antes.v ? agora.v : (agora.g !== antes.g ? agora.g : agora.s);
      }
      var codigo = typeof fn === 'function' ? textoDaFuncao(fn) : '';
      var nativo = sIndexOf(codigo, '[native code]') >= 0;
      emite(objeto({
        tipo: 'hook',
        api: alvo.api,
        momento: momento,
        nativo: nativo,
        sombreamento: sombreado,
        trecho: nativo ? '' : sSlice(codigo, 0, 200)
      }), 'hook|' + alvo.api + '|' + momento, true);
      capturarOrigem[alvo.api] = true;
    }
  }

  try {
    _apply(_addEventListener, doc, ['DOMContentLoaded', function () {
      comparaReferencias('DOMContentLoaded');
    }, true]);
    _apply(_addEventListener, win, ['load', function () {
      comparaReferencias('load');
      _apply(_setTimeout, win, [function () { comparaReferencias('load+3s'); }, 3000]);
    }, true]);
  } catch (e) { /* sem documento */ }

  // ------------------------------------------------------------ IndexedDB

  // fonte confiavel dos bancos abertos (indexedDB.databases() e complementar)
  var bancosVistos = new _Set();
  envolveMetodo(win.IDBFactory && IDBFactory.prototype, 'open', function (fabrica, args) {
    var nome = sSlice(_String(args[0]), 0, 64);
    if (setHas(bancosVistos, nome) || limiteAtingido()) return;
    setAdd(bancosVistos, nome);
    emite(objeto({ tipo: 'indexedDB', nome: nome, script: scriptDeOrigem() }));
  });
})();
