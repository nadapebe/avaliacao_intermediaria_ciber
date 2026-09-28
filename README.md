# PrivacyLens

Extensão para Firefox que detecta e apresenta ataques e violações de privacidade no cliente web: rastreadores, cookies, armazenamento HTML5, fingerprinting, sincronismo de cookies, bounce tracking e indícios de sequestro de navegador (hijacking e hook), com uma pontuação de privacidade por página.

Avaliação Intermediária de Cibersegurança — Insper.

---

## O que a ferramenta detecta

| Detecção | Como | Onde no código |
|---|---|---|
| Conexões a domínios de terceira parte | `webRequest` em todas as requisições, classificadas por **eTLD+1** (Public Suffix List embarcada) | `background/requests.js`, `lib/etld.js` |
| Cookies injetados no carregamento | header `Set-Cookie` + `cookies.onChanged` (JavaScript) + snapshot final; separa **1ª/3ª parte** e **sessão/persistente**, com SameSite, HttpOnly, Secure, particionamento e duração | `background/cookies.js` |
| Armazenamento HTML5 | `localStorage`, `sessionStorage`, IndexedDB e `document.cookie` em **todos os frames**, inclusive iframes de terceiros | `content/content.js` |
| Canvas fingerprint | instrumentação de `toDataURL`, `toBlob`, `getImageData`, `fillText`... com a heurística de Englehardt & Narayanan; vetores extras: WebGL, áudio, WebRTC, fontes, `navigator`, `screen` | `content/inject.js` |
| Cookie sync e bounce tracking | valor de cookie de A na URL de B; ID compartilhado entre terceiros; cadeia A → T → B no servidor (3xx) e no cliente (JavaScript); link decoration (`gclid`, `fbclid`, `utm_*`...) | `background/tracking.js` |
| Hijacking e hook | WebSocket e polling persistente para terceiros, script injetado após o `load`, troca de APIs nativas (`fetch`, XHR, `document.cookie`...), keylogging, session recording, assinatura BeEF | `background/hijack.js`, `content/inject.js` |
| Pontuação de privacidade | 0 a 100 (100 = melhor), 9 critérios com pesos que somam 100, nota de A a E | `background/score.js`, [METODOLOGIA.md](METODOLOGIA.md) |
| Lista de bloqueio personalizada | domínios ou padrões com `*`, interruptor geral, regras liga/desliga, contador de bloqueios | `background/blocklist.js` |

A metodologia completa (critérios, pesos, justificativas, comparação com os 7 testes do Blacklight e limitações) está em **[METODOLOGIA.md](METODOLOGIA.md)**.

---

## Instalação (via `about:debugging`)

Requisito: **Firefox 128 ou mais recente**.

1. Baixe o repositório: botão verde **Code** → **Download ZIP** no GitHub, e descompacte. Ou use `git clone <url-do-repositório>`.
2. Abra o Firefox e digite na barra de endereço:

   ```
   about:debugging#/runtime/this-firefox
   ```
3. Clique em **Carregar extensão temporária…** (*Load Temporary Add-on…*).
4. Entre na pasta do projeto e selecione o arquivo **`manifest.json`**.
5. O **PrivacyLens** aparece na lista, e o ícone da lupa azul aparece na barra de ferramentas. Se o ícone não aparecer, clique no ícone de peça de quebra-cabeça (Extensões) e fixe o PrivacyLens na barra.

> A extensão temporária fica carregada até o Firefox ser fechado. Para voltar a usar, repita os passos 2 a 4.
>
> Para ver o console da extensão (logs e erros), clique em **Inspecionar** ao lado do PrivacyLens em `about:debugging`.

**Permissões** e por que cada uma é necessária:

| Permissão | Para quê |
|---|---|
| `<all_urls>`, `webRequest`, `webRequestBlocking` | observar todas as requisições e bloquear as da lista personalizada |
| `cookies` | ler os cookies injetados, inclusive os particionados pelo Firefox |
| `webNavigation`, `tabs` | saber quando cada aba navega e qual aba está ativa |
| `storage` | guardar a lista de bloqueio |
| `downloads` | exportar o relatório em JSON |

Nenhum dado sai do navegador: a extensão não faz requisições próprias nem envia nada a servidores.

---

## Uso

1. Abra (ou recarregue, com F5) a página que quer analisar. O PrivacyLens só observa páginas carregadas **depois** dele.
2. Espere a página terminar de carregar e clique no ícone do PrivacyLens.
3. O popup mostra o relatório da página nas abas:

| Aba | Conteúdo |
|---|---|
| **Resumo** | score, nota, medidor e a quebra da nota por critério, com fórmula e justificativa de cada penalidade |
| **Terceiros** | domínios de terceira parte, número de requisições, tipos, sinais (cookie enviado ou recebido, classificação e bloqueios do Firefox, bloqueios da lista) e botão **Bloquear** |
| **Cookies** | matriz 1ª/3ª parte × sessão/persistente e a lista com duração e atributos |
| **Storage** | armazenamento HTML5 por origem de frame |
| **Fingerprint** | leituras de canvas com as 4 condições do critério e os demais vetores, com o script de origem |
| **Rastreio** | cookie sync, bounce tracking e link decoration |
| **Hijacking** | indícios por severidade, com a evidência |
| **Bloqueio** | lista personalizada: adicionar, remover, ligar/desligar cada regra, interruptor geral e contadores |
| **Erros** | falhas de execução capturadas nos módulos do plugin |

4. **Exportar JSON** baixa o relatório completo da aba para a pasta Downloads (`privacylens_<domínio>_<data-hora>.json`). Esse arquivo é a evidência usada nas tabelas do relatório do trabalho.
5. **Abrir em aba** abre o mesmo relatório numa aba normal, com altura livre. É útil para prints de página inteira.

### Lista de bloqueio

Por padrão o PrivacyLens é **só detector**: a lista começa vazia. Para bloquear um terceiro, clique em **Bloquear** na aba *Terceiros* ou digite o domínio na aba *Bloqueio*. A regra vale na hora para as próximas requisições. Recarregue a página para medir o carregamento inteiro com o bloqueio.

| Regra | Casa com |
|---|---|
| `doubleclick.net` | o domínio e todos os subdomínios |
| `*.hotjar.com` | só subdomínios |
| `ads.*.example.com` | padrão no host |
| `example.com/pixel` ou `example.com/pixel*` | host + caminho que **começam** assim, só nesse host (`www.example.com` não entra) |

Observações:

- Uma URL colada com `https://` e sem `*` vira o domínio inteiro.
- Padrões que casariam com quase tudo (`*`, `*.*`, `*/*`) são recusados.
- A navegação principal nunca é bloqueada. Mas, se você colocar na lista o próprio site que está visitando, os recursos dele (imagens, scripts) serão bloqueados.
- A lista é salva no navegador e vale para todas as abas.

---

## Estrutura

```
manifest.json            Manifest V2 (Firefox)
METODOLOGIA.md           critérios, pesos e justificativa do score; comparação com o Blacklight; limitações
icons/icon.svg
lib/
  psl-data.js            Public Suffix List embarcada (gerada em 2026-09-27)
  etld.js                resolução de eTLD+1
background/              carregados nesta ordem pelo manifest
  state.js               registro por aba (zerado a cada navegação)
  requests.js            webRequest e classificação 1ª/3ª parte
  cookies.js             cookies injetados (header, JavaScript, snapshot)
  tracking.js            cookie sync, bounce tracking, link decoration
  hijack.js              WebSocket, polling, scripts injetados, hooks, keylogging, BeEF
  score.js               pontuação de privacidade
  report.js              relatório serializável e exportação JSON
  blocklist.js           lista de bloqueio personalizada
  main.js                registro dos módulos, mensagens e erros
content/
  content.js             content script (todos os frames): storage HTML5, scripts injetados, ponte
  inject.js              script de página (world MAIN, document_start): canvas, vetores e hooks
popup/                   interface (popup.html, popup.css, popup.js)
evidencias/              HAR, prints e JSONs dos testes (ddg/ e sites/, ver evidencias/README.md)
```

JavaScript puro, sem dependências, sem etapa de build: o `manifest.json` carrega os arquivos diretamente.

---

## Testes e evidências

- **DuckDuckGo Privacy Test Pages:** https://privacy-test-pages.site. Os resultados, com prints do plugin e HAR, ficam em `evidencias/ddg/`.
- **3 sites reais:** `www.uol.com.br`, `www.magazineluiza.com.br` e `edition.cnn.com`, comparados com o **Blacklight** (The Markup) e com os bloqueios do **uBlock Origin**. As evidências ficam em `evidencias/sites/`.
- O relatório final em PDF reúne a tabela do DDG, a reconciliação dos 3 sites e a aplicação do score.

**Recomendação para reproduzir as medições** (detalhes na seção 7 de [METODOLOGIA.md](METODOLOGIA.md)):

- use um **perfil limpo** do Firefox, sem outras extensões (o uBlock Origin, por exemplo, altera a página e seria apontado como hook);
- deixe a proteção contra rastreamento no modo **Padrão**;
- use uma **janela normal**. Na janela privativa o Firefox bloqueia mais rastreadores.

---

## Limitações principais

- **Atribuição de cookies escritos por JavaScript:** `cookies.onChanged` não informa a aba. A atribuição é feita pela janela de carregamento e pelo domínio já contatado.
- **Detector, não bloqueador, por padrão:** as páginas de teste do DuckDuckGo medem bloqueio, então divergências são esperadas e explicadas no relatório.
- **Instrumentação na página:** a instrumentação roda no contexto da página. Workers, service workers e iframes `about:blank` vazios não são instrumentados.
- **Heurísticas:** os critérios de canvas, polling e bounce no cliente são heurísticos. Os limiares estão documentados.

A lista completa está em [METODOLOGIA.md](METODOLOGIA.md#8-limitações-metodológicas).
