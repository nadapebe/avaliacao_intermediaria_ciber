'use strict';

/**
 * Lista de bloqueio personalizada.
 *
 * O usuario mantem uma lista de dominios ou padroes simples com "*", salva
 * em browser.storage.local. Um listener webRequest.onBeforeRequest com
 * ["blocking"] devolve {cancel: true} para as requisicoes que casarem, e o
 * bloqueio e contado por dominio no registro da aba (rec.blocked), que o
 * score usa: um terceiro com todas as requisicoes bloqueadas nao conta como
 * contatado.
 *
 * Regras de casamento:
 *   - "doubleclick.net"          -> o host e todos os subdominios;
 *   - "*.doubleclick.net"        -> so subdominios ("*" = qualquer sequencia);
 *   - "ads.*.example.com"        -> padrao no host;
 *   - "example.com/pixel*"       -> com "/": host + caminho que COMECAM assim
 *                                   (so esse host; "www.example.com" nao).
 * Uma URL colada com esquema (https://...) sem "*" vira o dominio inteiro.
 *
 * Nunca bloqueia a navegacao principal (main_frame): a lista serve para
 * cortar recursos de terceiros, nao para impedir o usuario de abrir um site.
 * Ha um interruptor geral e cada regra pode ser ligada/desligada.
 * Por padrao o PrivacyLens e um detector: a lista comeca vazia.
 */

var PL = window.PL || (window.PL = {});

(function () {
  var CHAVE = 'blocklist';
  var REGRAS_LIMITE = 500;
  var PADRAO_MAX = 200;
  var ASTERISCOS_MAX = 10;

  var config = { ativo: true, regras: [] };   // regras: [{padrao, ativo, criadoEm}]
  var compiladas = [];                         // [{padrao, testa(host, hostCaminho)}]
  var contadores = new Map();                  // padrao -> bloqueios nesta sessao
  var totalSessao = 0;
  var carregada = false;
  var pronta = Promise.resolve();              // resolve quando a lista salva foi lida

  // ------------------------------------------------------------ padroes

  /**
   * Normaliza o texto digitado pelo usuario. Devolve '' se for invalido.
   * Aceita uma URL colada (remove esquema, e o caminho quando nao ha "*").
   */
  function normaliza(texto) {
    var p = String(texto || '').trim().toLowerCase();
    var tinhaEsquema = /^[a-z][a-z0-9+.-]*:\/\//.test(p);
    p = p.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // esquema
    p = p.replace(/^\.+/, '');
    // URL colada (com esquema) e sem "*": vale o dominio inteiro. Digitado
    // sem esquema, "exemplo.com/ads" continua sendo um padrao de caminho.
    if (tinhaEsquema && p.indexOf('*') < 0) p = p.split(/[\/?#]/)[0];
    p = p.split('#')[0];
    p = p.replace(/:\d+(?=\/|$)/, '');                 // porta
    p = p.replace(/\/+$/, '');
    p = p.replace(/\*+/g, '*');
    if (!p || p.length > PADRAO_MAX) return '';
    if (!/^[a-z0-9.*_\-\/%?=&~:+]+$/.test(p)) return '';
    // sem "/", o padrao e de host: "?", "=", "&"... nunca casariam
    if (p.indexOf('/') < 0 && !/^[a-z0-9.*_\-]+$/.test(p)) return '';
    // padroes que casariam com quase tudo: exigem 3 letras/digitos
    if ((p.match(/[a-z0-9]/g) || []).length < 3) return '';
    if ((p.match(/\*/g) || []).length > ASTERISCOS_MAX) return '';
    return p;
  }

  /**
   * Casamento de padrao com "*" em tempo linear, sem RegExp. Uma expressao
   * regular com varios ".*" pode levar segundos (backtracking), e este
   * listener e bloqueante: toda requisicao do Firefox esperaria por ele.
   * "fim": o texto inteiro precisa casar (host); sem "fim", basta o
   * comeco (host + caminho).
   */
  function casaGlob(partes, s, fim) {
    var n = partes.length;
    var pos = partes[0].length;
    if (s.lastIndexOf(partes[0], 0) !== 0) return false;
    if (n === 1) return !fim || s.length === pos;
    for (var i = 1; i < n - 1; i++) {
      var k = s.indexOf(partes[i], pos);
      if (k < 0) return false;
      pos = k + partes[i].length;
    }
    var ultima = partes[n - 1];
    return fim ?
      (s.length - ultima.length >= pos && s.slice(s.length - ultima.length) === ultima) :
      s.indexOf(ultima, pos) >= 0;
  }

  function compila(padrao) {
    var comCaminho = padrao.indexOf('/') >= 0;
    if (padrao.indexOf('*') < 0 && !comCaminho) {
      // dominio puro: o proprio host ou qualquer subdominio
      return function (host) {
        return host === padrao || host.slice(-(padrao.length + 1)) === '.' + padrao;
      };
    }
    var partes = padrao.split('*');
    return comCaminho ?
      function (host, hostCaminho) { return casaGlob(partes, hostCaminho, false); } :
      function (host) { return casaGlob(partes, host, true); };
  }

  function recompila() {
    compiladas = config.regras.filter(function (r) { return r.ativo; }).map(function (r) {
      return { padrao: r.padrao, testa: compila(r.padrao) };
    });
  }

  /** Primeira regra ativa que casa com a URL, ou null. */
  function regraPara(url) {
    if (!config.ativo || !compiladas.length) return null;
    var u;
    try { u = new URL(url); } catch (e) { return null; }
    var host = u.hostname.toLowerCase().replace(/\.$/, '');
    var hostCaminho = (host + u.pathname + u.search).toLowerCase(); // o padrao e minusculo
    for (var i = 0; i < compiladas.length; i++) {
      if (compiladas[i].testa(host, hostCaminho)) return compiladas[i].padrao;
    }
    return null;
  }

  // ------------------------------------------------------------ persistencia

  function salva() {
    return browser.storage.local.set({ blocklist: config }).catch(function (e) {
      PL.warn('falha ao salvar a lista de bloqueio:', e);
    });
  }

  function carrega() {
    return browser.storage.local.get(CHAVE).then(function (dados) {
      var c = dados && dados[CHAVE];
      if (c && Array.isArray(c.regras)) {
        config.ativo = c.ativo !== false;
        config.regras = c.regras.filter(function (r) {
          return r && typeof r.padrao === 'string';
        }).map(function (r) {
          return { padrao: normaliza(r.padrao), ativo: r.ativo !== false, criadoEm: r.criadoEm || Date.now() };
        }).filter(function (r, i, todas) {
          // descarta invalidas e duplicadas apos a normalizacao
          if (!r.padrao) return false;
          for (var j = 0; j < i; j++) if (todas[j].padrao === r.padrao) return false;
          return true;
        }).slice(0, REGRAS_LIMITE);
      }
      recompila();
      carregada = true;
    }).catch(function (e) {
      carregada = true;
      PL.warn('falha ao carregar a lista de bloqueio:', e);
    });
  }

  // ------------------------------------------------------------ bloqueio

  function onBeforeRequest(details) {
    if (details.type === 'main_frame') return undefined;
    if (!/^(https?|wss?):/i.test(details.url)) return undefined;
    var padrao = regraPara(details.url);
    if (!padrao) return undefined;

    totalSessao++;
    contadores.set(padrao, (contadores.get(padrao) || 0) + 1);
    var rec = details.tabId >= 0 ? PL.state.get(details.tabId) : null;
    if (rec) {
      var dominio = PL.requests.dominioDe(details.url);
      rec.blocked.count++;
      rec.blocked.byDomain.set(dominio, (rec.blocked.byDomain.get(dominio) || 0) + 1);
    }
    return { cancel: true };
  }

  // ------------------------------------------------------------ estado e mensagens

  function estado() {
    return {
      ativo: config.ativo,
      carregada: carregada,
      totalSessao: totalSessao,
      regras: config.regras.map(function (r) {
        return { padrao: r.padrao, ativo: r.ativo, criadoEm: r.criadoEm, bloqueiosSessao: contadores.get(r.padrao) || 0 };
      })
    };
  }

  function responde(promessa) {
    return promessa.then(function () { return { ok: true, estado: estado() }; });
  }

  function onMensagem(msg, sender) {
    if (!PL.mensagemDaExtensao(sender)) return undefined;
    // uma regra adicionada antes da leitura da lista salva nao pode se perder
    return pronta.then(function () { return trataAcao(msg); });
  }

  function trataAcao(msg) {
    var acao = msg.acao;

    if (acao === 'estado') return Promise.resolve({ ok: true, estado: estado() });

    if (acao === 'geral') {
      config.ativo = msg.ativo === true;
      return responde(salva());
    }

    var padrao = normaliza(msg.padrao);
    if (!padrao) {
      return Promise.resolve({ ok: false, erro: 'Padrão inválido. Use um domínio (ex.: doubleclick.net) ou um padrão com * (ex.: *.hotjar.com).', estado: estado() });
    }
    var i = -1;
    config.regras.forEach(function (r, k) { if (r.padrao === padrao) i = k; });

    if (acao === 'adicionar') {
      if (i >= 0) {
        config.regras[i].ativo = true;
      } else {
        if (config.regras.length >= REGRAS_LIMITE) {
          return Promise.resolve({ ok: false, erro: 'Limite de ' + REGRAS_LIMITE + ' regras atingido.', estado: estado() });
        }
        config.regras.push({ padrao: padrao, ativo: true, criadoEm: Date.now() });
      }
    } else if (acao === 'remover') {
      if (i >= 0) config.regras.splice(i, 1);
    } else if (acao === 'alternar') {
      if (i >= 0) config.regras[i].ativo = msg.ativo === true;
    } else {
      return Promise.resolve({ ok: false, erro: 'Ação desconhecida.', estado: estado() });
    }
    recompila();
    return responde(salva());
  }

  PL.blocklist = {
    estado: estado,
    regraPara: regraPara,
    normaliza: normaliza,

    /** Registra o listener bloqueante e as mensagens. Chamado por background/main.js. */
    register: function () {
      browser.webRequest.onBeforeRequest.addListener(
        PL.guard('blocklist.onBeforeRequest', onBeforeRequest),
        { urls: ['<all_urls>'] },
        ['blocking']
      );
      PL.onMensagem('bloqueio', onMensagem);
      pronta = carrega();
    }
  };
})();
