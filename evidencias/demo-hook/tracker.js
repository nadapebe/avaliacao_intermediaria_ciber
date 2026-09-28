'use strict';
/*
 * tracker.js — script de TESTE (terceira parte: 127.0.0.1).
 *
 * Aciona os detectores de hijacking do PrivacyLens. NÃO captura, guarda nem
 * envia dados do usuário: é uma banca de teste offline para provar a detecção.
 */
(function () {
  var BASE = 'http://127.0.0.1:8089';

  // 1. HOOK de API nativa: envolve fetch com um wrapper que chama o original.
  var fetchOriginal = window.fetch;
  window.fetch = function () {
    // apenas repassa a chamada; serve so para o detector ver a troca de fetch
    return fetchOriginal.apply(this, arguments);
  };

  // 2. WEBSOCKET para terceiro (a conexao pode falhar; o indicio e a tentativa).
  try { new WebSocket('ws://127.0.0.1:8089/canal'); } catch (e) { /* */ }

  // 3. POLLING persistente: mesma URL a cada 2 s.
  setInterval(function () {
    fetchOriginal(BASE + '/poll', { mode: 'no-cors' }).catch(function () { /* */ });
  }, 2000);

  // 4. SCRIPT INJETADO em runtime, depois do load, de terceira parte.
  window.addEventListener('load', function () {
    setTimeout(function () {
      var s = document.createElement('script');
      s.src = BASE + '/injetado.js';
      document.body.appendChild(s);
    }, 1500);
  });

  // 5. KEYLOGGING (capacidade): registra um listener de teclado que NAO faz
  //    nada com as teclas. O detector aponta a capacidade, nao a exfiltracao.
  document.addEventListener('keydown', function () {
    /* intencionalmente vazio: nao le nem envia a tecla */
  });
})();
