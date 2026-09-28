# Demonstração de hijacking / hook (Conceito A)

Página de teste **local** que aciona, de propósito, os indícios de sequestro de
navegador que o PrivacyLens detecta. Serve de prova para o Conceito A, já que a
página `js-leaks` do DuckDuckGo não simula um ataque real.

A página (primeira parte) é servida em `http://localhost:8089` e o script de
"rastreador" (terceira parte) em `http://127.0.0.1:8089` — `localhost` e
`127.0.0.1` são domínios registráveis diferentes, então o script é terceira parte.

O script `tracker.js` faz, cada um acionando um detector:

| Comportamento | Detector |
|---|---|
| envolve `window.fetch` com um wrapper que chama o original | hook de API nativa |
| abre `new WebSocket('ws://127.0.0.1:8089/canal')` | WebSocket para terceiro |
| requisita `/poll` a cada 2 s | polling persistente |
| injeta `<script src>` de terceiro depois do `load` | script injetado |
| registra um listener de `keydown` (que NÃO captura nada) | keylogging |

Como o mesmo terceiro (`127.0.0.1`) tem WebSocket, polling e listener de teclado,
o hook é classificado como severidade **alta**.

Nada é capturado nem enviado a servidor externo: é uma banca de teste offline.

## Como rodar

```
python3 evidencias/demo-hook/servidor.py
```

Depois abra no Firefox: http://localhost:8089/demo.html
