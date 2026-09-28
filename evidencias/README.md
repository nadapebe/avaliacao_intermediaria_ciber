# Evidências

Esta pasta guarda as evidências de execução exigidas pelo enunciado.

```
evidencias/
├─ instalacao_about-debugging.png   plugin carregado em about:debugging
├─ ddg/        testes nas DuckDuckGo Privacy Test Pages
├─ demo-hook/  demonstração local de hijacking/hook (ver demo-hook/README.md)
└─ sites/      os 3 sites reais: uol/, magazineluiza/, cnn/
```

## Convenção de nomes

**`ddg/`**: um conjunto por teste (`<teste>` = nome da página, ex.: `storage-blocking`). O sufixo `_com-bloqueio` indica o teste repetido com a lista de bloqueio do plugin ativada.

- `<teste>.json`: relatório exportado pelo PrivacyLens
- `<teste>.har`: tráfego exportado do DevTools do Firefox (sanitizado, ver abaixo)
- `<teste>_plugin.png`: print do PrivacyLens em execução na página de teste

**`demo-hook/`**: `demo-hook.json`, `demo-hook.har` e `demo-hook_plugin.png`, mais o código da demonstração (`demo.html`, `tracker.js`, `injetado.js`, `servidor.py`).

**`sites/<site>/`** (`<site>` = `uol`, `magazineluiza` ou `cnn`):

- `<site>.json`: relatório exportado pelo PrivacyLens
- `<site>.har`: tráfego exportado do DevTools do Firefox (sanitizado, ver abaixo)
- `<site>_plugin_resumo.png`, `_plugin_terceiros.png`, `_plugin_cookies.png`, `_plugin_hijacking.png`: prints das abas do PrivacyLens
- `<site>_blacklight.png`: print do relatório do Blacklight (The Markup)
- `blacklight/`: inspeção do Blacklight como foi baixada
  - `report.html`: relatório
  - `raw/inspection.json`: resultado dos testes
  - `raw/requests.har`: tráfego do navegador do Blacklight
  - `raw/browser-cookies.json`: cookies ao fim da inspeção
  - `raw/inspection-log.ndjson`: log da inspeção (só Magalu e CNN)
  - `html/<n>.html` e `screenshots/<n>.jpeg`: páginas visitadas (a CNN só tem `screenshots/2.jpeg`)
- `<site>_ublock.png`, `<site>_ublock.txt`: bloqueios registrados no Logger do uBlock Origin, em perfil separado
- `reconciliacao_blacklight.md`: comparação domínio a domínio entre PrivacyLens e Blacklight, com a evidência de cada divergência

## HAR públicos sanitizados

Os `.har` publicados aqui são **cópias sanitizadas**. Os originais (`*_original.har`) ficam só na máquina local e estão no `.gitignore`.

A sanitização troca por `[REMOVIDO]`:

- os valores de `request.cookies` e `response.cookies`;
- os valores dos cabeçalhos `Cookie`, `Set-Cookie` e `Authorization`, e de cabeçalhos cujo nome contém `token`, `auth`, `session` ou `email`;
- os parâmetros de query string e de postData com esses nomes;
- os mesmos valores onde mais aparecem (URLs, corpos, cabeçalhos, inclusive em base64), como no cookie sync;
- o endereço IP do usuário, também nas cópias do Blacklight.

Continuam intactos: hosts, métodos, status, tipos, tamanhos, tempos e os **nomes** dos cookies. O path das URLs também fica, exceto IDs longos que tenham sido removidos. Timestamps Unix não são considerados identificadores e ficam.
