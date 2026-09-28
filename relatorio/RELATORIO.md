# PrivacyLens: relatório de avaliação

Avaliação Intermediária de Cibersegurança (Insper).

Todos os números vêm dos arquivos em `evidencias/`: os JSON exportados pelo PrivacyLens, os HAR do Firefox (versões públicas sanitizadas) e as inspeções do Blacklight. Os resultados reportados pelas próprias páginas de teste foram lidos nos prints `evidencias/ddg/*_plugin.png`.

---

## 1. Testes nas páginas do DuckDuckGo (entregável 2)

O PrivacyLens **detecta** e, por padrão, **não bloqueia** (METODOLOGIA, seção 8, item 4). As páginas do DuckDuckGo reportam o que o navegador ou a extensão **bloqueou**. Por isso a divergência esperada é “a página diz que carregou, e o plugin mostra que carregou e quem recebeu”. Nos dois testes `_com-bloqueio`, a lista de bloqueio do plugin (aba *Bloqueio*) foi ativada.

Todos os testes rodaram no Firefox com ETP Padrão. Os scores abaixo foram recalculados a partir dos JSON e batem com o export.

| Teste | Resultado esperado (reportado pela página) | Resultado do plugin | Explicação da divergência | Print |
|---|---|---|---|---|
| tracker-reporting-img | A página declara “1 major tracker loaded via img src” e carrega `<img src="//facebook.com/tr?test=1">` (corpo HTML no HAR). Espera que a proteção **reporte 1 rastreador** (facebook.com). | 1 terceiro: `facebook.com` (`GET facebook.com/tr` → 200) e cookie `fr` de facebook.com, persistente (90 dias) e particionado pelo Total Cookie Protection. Score **93 A** (terceiros 3 + cookies 3ª 4). `facebookPixel: false`. | **Concordam** em 1 rastreador. O plugin não bloqueia; ele mostra que a requisição saiu e que o cookie foi gravado. O pixel fica `false` porque a URL tem `test=1` e não `ev=`, e a regra do Blacklight exige o parâmetro `ev`. | `evidencias/ddg/tracker-reporting-img_plugin.png` |
| tracker-reporting-script | A página declara “1 major tracker loaded via script src” e carrega `<script src="//doubleclick.net/tracker.js">`. Espera **1 rastreador reportado** (doubleclick.net). | 1 terceiro: `doubleclick.net` (1 req.). No HAR a resposta é **404**, e o JSON registra `NS_ERROR_CORRUPTED_CONTENT`: o Firefox rejeitou a página de erro HTML como script. Score **97 A** (terceiros 3). | **Concordam** em 1 rastreador. A requisição saiu do navegador (o 404 veio do servidor), por isso o domínio conta no critério 1: ele recebeu IP e Referer. | `evidencias/ddg/tracker-reporting-script_plugin.png` |
| request-blocking | A página dispara cerca de 20 tipos de requisição (script, CSS, iframe, fetch, XHR, beacon, WebSocket, SSE, imagem, áudio, vídeo, fonte, favicon, CSP report…) para `bad.third-party.site/block-me/…` e marca cada uma como carregada ou bloqueada. **No print:** todos os itens visíveis das seções HTML (script, style, img, picture, object, audio, video, iframe) e CSS (import, font, background) aparecem com quadrado **verde** (carregado, não bloqueado); a seção JS fica abaixo da área visível. O DevTools no mesmo print mostra o WebSocket com `NS_ERROR_WEBSOCKET_CONNECTION_REFUSED`. Pelo HAR, todas carregaram (200/204/206), exceto o redirecionamento `privacy-test-pages.site/redirect` (307), o handshake do WebSocket (404) e o `<object>` (status 0). | 1 terceiro: `third-party.site` (22 req.). Indício **WebSocket para terceiro** (`wss://bad.third-party.site/block-me/web-socket`, média, +5) e script injetado (baixa, sem peso). Score **92 A**. | Divergência esperada: sem a lista de bloqueio o plugin só observa. Ele aponta o domínio, o WebSocket e o script injetado, mas a página vê tudo carregado. | `evidencias/ddg/request-blocking_plugin.png` |
| request-blocking_com-bloqueio | Mesma página, agora com a regra `bad.third-party.site` ativa na lista do plugin. Espera **todas as requisições de terceiro bloqueadas**. **No print:** os itens HTML e CSS visíveis passam a **cinza/vermelho** (não carregados), e o DevTools mostra cada pedido a `bad.third-party.site` como “Bloqueado por PrivacyLens”; a aba *Bloqueio* do plugin informa “22 requisições canceladas”. | 22 requisições canceladas pelo plugin (`bloqueadasPlugin: 22`, erro `NS_ERROR_ABORT`; no HAR, todas as de `bad.third-party.site` têm status 0). Critério 1 = 0, porque nenhum dado chegou ao terceiro. O indício de WebSocket continua (+5), porque o **construtor** foi chamado na página, mesmo com a conexão cancelada. Score **95 A**. | Com a lista ativa, o plugin passa a bloquear e a página deve reportar bloqueio. A única penalidade que sobra é a tentativa de WebSocket, que é comportamento da página, e não tráfego. | `evidencias/ddg/request-blocking_com-bloqueio_plugin.png` |
| storage-blocking | A página grava cookies (HTTP e JS), localStorage, sessionStorage, IndexedDB e Cache em 1ª parte e em iframes de `good.third-party.site`, `broken.third-party.site` (rastreador) e `convert.ad-company.site`, recarrega e diz o que **sobreviveu**. **No print:** “Retrieved data from 23 storage mechanisms (2 failed)”, ou seja, 21 mecanismos devolveram o dado gravado (detalhe por mecanismo recolhido no print). O popup mostra 24 cookies injetados (17 de 3ª parte) e 4 origens com storage. | 17 cookies de 3ª parte persistentes, todos **particionados** (`__Host-jsdata_host`, `jsdata`, `*_headerdata`…); 3 origens de 3ª parte com storage (broken e good third-party, convert.ad-company); 6 cookies de 1ª parte longos. Score **61 B**. | O Firefox **particiona** (Total Cookie Protection) e não bloqueia. Dentro do iframe o dado persiste, então a página tende a reportar “armazenado”. O PrivacyLens conta os particionados de propósito (METODOLOGIA 2.1, item 2), porque eles ainda identificam o usuário dentro do site. | `evidencias/ddg/storage-blocking_plugin.png` |
| storage-blocking_com-bloqueio | Mesma página com a regra `broken.third-party.site` na lista. Espera que o storage do rastreador **não** seja gravado. **No print:** “Retrieved data from 23 storage mechanisms (**3 failed**)”, uma falha a mais que sem bloqueio. O popup mostra a regra `broken.third-party.site` com 8 bloqueios, e o DevTools mostra `broken.third-party.site/reflect-headers` como “Bloqueado por PrivacyLens”. | 8 requisições canceladas (`broken.third-party.site`: iframe, `set-cookie`, `reflect-headers` com status 0 no HAR). O storage de 3ª parte cai de 3 para **2** origens (sai broken.third-party.site) e os cookies de 3ª parte **injetados nesta visita** caem de 17 para **9**. Score **64 B**. | O bloqueio tira o storage do terceiro listado; good.third-party.site e convert.ad-company.site continuam. Duas ressalvas: `broken.third-party.site/3rdparty.js` ainda carregou (está no requestLog sem erro, provavelmente do cache), e os cookies do rastreador gravados no teste anterior continuam no navegador como pré-existentes (`injetado: false`). A queda de 17 para 9 significa “não regravados”, e não “ausentes”. | `evidencias/ddg/storage-blocking_com-bloqueio_plugin.png` |
| storage-partitioning | Dados brutos da própria página (`/partitioning/get-results` no HAR): nos iframes **same-site** (contextos 0 e 1), cookie, localStorage, sessionStorage, IndexedDB, Cache API, ServiceWorker, BroadcastChannel, SharedWorker e Web Locks devolvem o mesmo valor. Nos **cross-site** (contextos 2 e 3) todos devolvem `null`, o que indica **armazenamento particionado**. Os contextos 4 a 7 testam só HSTS. **No print:** “Retrieved data from 21 storage mechanisms” e a lista com ✅ **pass** para document.cookie, HTTP Cookie, Cookie Store API, localStorage, sessionStorage, IndexedDB e Cache API (WebSQL: unsupported). O restante da lista fica abaixo da área visível. | 1 terceiro: `privacy-test-pages.site` (3 req.: `set_hsts.png`, `clear_hsts.png`); 3 cookies de 1ª parte longos (`partition_test` 400 dias ×2, `partition_test_http` 1.423 dias). Score **94 A**. | Sem divergência de fato: a página testa o **isolamento** feito pelo navegador, e o plugin não mede isolamento. Ele só registra os cookies criados (que são de 1ª parte em `first-party.site`) e o terceiro contatado. | `evidencias/ddg/storage-partitioning_plugin.png` |
| fingerprinting | A página chama dezenas de APIs de fingerprinting (canvas, WebGL, áudio, navigator, screen, fontes…) e mostra os valores obtidos. **No print:** “Collected 124 datapoints (14 failed)”, isto é, a página conseguiu ler 110 pontos de dados do navegador (nenhuma proteção os mascarou). | **Canvas fingerprinting detectado** (`helpers/tests.js`, canvas 2000×200; 3 leituras: `toDataURL`, `getImageData`, `toDataURL`, e só a primeira atende todos os critérios). Vetores adicionais: `navigator.hardwareConcurrency`, `languages`, `plugins`, `screen`, varredura de parâmetros WebGL, WebRTC, enumeração de fontes, áudio. Score **85 A** (canvas 15). | **Concordam**: a página faz fingerprinting e o plugin detecta. O plugin não bloqueia, então os valores reais continuam expostos à página. | `evidencias/ddg/fingerprinting_plugin.png` |
| bounce-tracking | `bounce.html` em `bad.third-party.site` grava `bounceUID` (localStorage + cookie de 60 dias) e redireciona por JavaScript para `privacy-test-pages.site/…/?bounceUIDlocalStorage=…&bounceUIDcookie=…&isNew=…` (código no HAR). A URL de destino registrada no JSON (`pagina.url`) é `…/bounce-tracking/?bounceUIDlocalStorage=54&bounceUIDcookie=54&isNew=`: o ID do rastreador **persistiu** no localStorage e no cookie (vinha de uma visita anterior, `isNew` vazio), ou seja, o estado do bounce tracker não foi limpo. | **Bounce no cliente** detectado: `privacy-test-pages.site → third-party.site → privacy-test-pages.site`. Critério 7 = 15. Score **85 A**. | **Concordam** na existência do bounce. O plugin detecta e penaliza, mas não apaga o estado do rastreador, e o ETP Padrão também não apagou (ID 54 preservado). | `evidencias/ddg/bounce-tracking_plugin.png` |
| query-parameters | A página de destino `query.html` imprime a query string que recebeu (`main.js`: `URLSearchParams(location.search)`). Uma proteção removeria `fbclid` e `fb_source`. A URL carregada (JSON `pagina.url`) é `query.html?fbclid=12345&fb_source=someting&u=14`, então a página exibe `fbclid=12345&fb_source=someting&u=14`: nada foi removido. | 2 **decorações de link** na navegação: `fbclid` e `fb_source`. Sem peso no score (METODOLOGIA 4). Score **100 A**. | Divergência esperada: o plugin mostra os parâmetros de rastreamento, mas não os remove da URL. | `evidencias/ddg/query-parameters_plugin.png` |
| js-leaks | A página compara as propriedades globais do `window` com um perfil de Firefox limpo (`security/browser-profiles/firefox_92.json`, única requisição do HAR) e lista as diferenças. Espera **nenhuma propriedade vinda de extensão**. **No print** (comparação com “Firefox 92”): a lista “Properties Added” começa com APIs padrão do Firefox atual que não existiam na versão 92 (`window.AbortController`, `AbortSignal`, `AbstractRange`, `AggregateError`, `AnalyserNode`, `Animation`…); nas linhas visíveis não há propriedade do PrivacyLens, mas a lista completa não aparece no print. | Nenhum indício de hook, nenhum terceiro, nenhum cookie. Aparecem só os vetores que a própria página lê (`navigator.*`, `screen`). Score **100 A**. | **Concordam**: a instrumentação do plugin não cria propriedades em `window`, e os wrappers devolvem o `toString` nativo (METODOLOGIA 5), então a página não os vê. | `evidencias/ddg/js-leaks_plugin.png` |

---

## 2. Hijacking e hook (Conceito A)

### 2.1 js-leaks: o plugin não é detectado e não se autodetecta

O PrivacyLens também faz hooking para medir (instrumenta `fetch`, `XMLHttpRequest`, `WebSocket`, canvas etc.). Na página `js-leaks` do DuckDuckGo:

- o export (`evidencias/ddg/js-leaks.json`) tem **0 indícios de hijacking** e score 100 A. O detector de hook não aponta a instrumentação do próprio plugin, porque as referências são guardadas depois dela e os wrappers ficam num mapa interno;
- no print (`evidencias/ddg/js-leaks_plugin.png`), as propriedades listadas em “Properties Added” são APIs padrão do Firefox atual ausentes no perfil Firefox 92, e nenhuma das linhas visíveis é do PrivacyLens. O plugin não cria propriedades em `window`, e `Function.prototype.toString` devolve o texto nativo para os wrappers. A lista completa não cabe no print, então a verificação exaustiva exigiria o botão “Download the results” da página.

A página `js-leaks`, porém, não simula um ataque. Para mostrar a detecção em ação foi montada a demonstração abaixo.

### 2.2 Demonstração local (`evidencias/demo-hook/`)

A página `http://localhost:8089/demo.html` (1ª parte) carrega `http://127.0.0.1:8089/tracker.js`. Como `localhost` e `127.0.0.1` são domínios registráveis diferentes, o script é de **3ª parte**. Ele não captura nem envia nada: é uma bancada offline (`evidencias/demo-hook/README.md`).

| Comportamento em `tracker.js` | Indício no PrivacyLens (`demo-hook.json`) | Severidade | Peso |
|---|---|---|---|
| `window.fetch = function(){ return fetchOriginal.apply(this, arguments) }` | **Hook de API nativa**: “fetch alterado em DOMContentLoaded, load, load+3s”, atribuído a 127.0.0.1 | **alta**, porque o mesmo terceiro também faz polling, abre WebSocket e escuta teclado | critério 8 |
| `new WebSocket('ws://127.0.0.1:8089/canal')` | **WebSocket para terceiro**: `ws://127.0.0.1:8089/canal` | média | critério 8 |
| `setInterval(() => fetchOriginal(BASE + '/poll'), 2000)` | **Polling persistente**: “127.0.0.1/poll: 48 requisições, intervalo mediano 2004 ms em 94 s”. O `demo-hook.har` tem 49 × `GET 127.0.0.1:8089/poll → 200` | média | critério 8 (3 indícios × 5 = 15, limitado ao teto de 10) |
| `<script src=".../injetado.js">` adicionado 1,5 s após o `load` | **Script injetado**: `http://127.0.0.1:8089/injetado.js` | baixa | 0 (informativo) |
| `document.addEventListener('keydown', …)` (vazio) | **Keylogging (capacidade)**: “listeners keydown registrados por http://127.0.0.1:8089/tracker.js” | média | +5 (critério 9) |

**Score: 82, nota A.** As penalidades são: terceiros 3 (1 domínio), hijacking 10 (3 indícios média/alta, no teto) e session/keylogging 5, total 18. O print está em `evidencias/demo-hook/demo-hook_plugin.png`.

**Leitura crítica.** A nota continua **A** mesmo com todos os indícios de sequestro ativos, porque o critério 8 pesa no máximo 10 pontos e a página não tem cookies, storage nem fingerprinting. É uma escolha de pesos (METODOLOGIA 8, item 12): o score mede **privacidade** de forma agregada, e o sequestro fica visível na aba *Hijacking* e na quebra por critério, não na letra final. Num laboratório com BeEF, o `hook.js` + polling ativaria também a assinatura BeEF (alta).

---

## 3. Análise dos 3 sites (entregável 3)

Sites sorteados: **UOL**, **Magazine Luiza** e **CNN**. Todos foram medidos em 2026-09-28, no Firefox com ETP Padrão e o banner aceito (protocolo da METODOLOGIA 7). O Blacklight rodou no mesmo dia, cerca de 5 a 20 minutos depois. A reconciliação completa, com tabela domínio a domínio e evidência de tráfego em cada divergência, está em:

- `evidencias/sites/uol/reconciliacao_blacklight.md`
- `evidencias/sites/magazineluiza/reconciliacao_blacklight.md`
- `evidencias/sites/cnn/reconciliacao_blacklight.md`

### 3.1 Resumo da reconciliação com o Blacklight

| Teste do Blacklight | UOL (BL / PL) | Magazine Luiza (BL / PL) | CNN (BL / PL) |
|---|---|---|---|
| 1. Ad trackers | 21 / 73 terceiros | 1 / 33 | 0 / 57 |
| 2. Cookies de 3ª parte | 14 / 62 persistentes | 0 / 16 | 2 / 26 |
| 3. Canvas fingerprinting | não / não | **sim / sim (mesmo script)** | não / não |
| 4. Session recording | não / sim (heurística) | **Hotjar / Hotjar** | não / sim (heurística) |
| 5. Key logging | não / listeners | sim (busca, 1ª parte) / listeners de 3ª | não / listeners |
| 6. Pixel do Facebook | sim (pág. interna) / não | não / **não (falso negativo)** | não / não |
| 7. GA remarketing | **sim / sim (G-BS4Q6LCGB1)** | não / sim | não / não |

**Principais achados, com a evidência de cada um:**

1. **UOL: página única x home + página interna.** O pixel do Facebook, o Microsoft Clarity, o Bing e a DoubleVerify só aparecem na página interna `/flash/?c=…` que o Blacklight visitou. Os eventos do T6 têm `pageUrl` dessa página, e o `requests.har` do Blacklight mostra Referer `www.uol.com.br/flash/`. O `uol.har` (só a home) tem 0 requisições a facebook.*. No teste 7 os dois acham a **mesma propriedade** `G-BS4Q6LCGB1` em `stats.g.doubleclick.net/g/collect`.
2. **UOL: leilão e geografia.** 37 domínios só no PrivacyLens, cerca de 30 deles parceiros de header bidding e cookie sync (ex.: `sync.1rx.io/usersync2/rmpssp`, `bidr.io`, `3lift.com`), ausentes do `requests.har` do Blacklight, que roda em `us-ca` emulando iPhone.
3. **Magazine Luiza: o Blacklight foi bloqueado.** `GET https://www.magazineluiza.com.br/ → 403`, título “Não é possível acessar a página” e CSS `wx.mlcdn.com.br/akamai-bot/…` (proteção de bot da Akamai). O relatório do Blacklight descreve na prática a central de ajuda (Zendesk). Mesmo assim os dois concordam no **canvas fingerprinting** (o mesmo caminho `…/OCrauuRaQfiZySGsFhPhTAf7/…/dT8P`, script anti-bot de 1ª parte) e no **Hotjar**.
4. **Magazine Luiza: possível falso negativo do pixel.** O `magazineluiza.har` tem `connect.facebook.net/en_US/fbevents.js` e dois `POST www.facebook.com/tr/` em `multipart/form-data` com `ev=PageView` e `ev=SubscribedButtonClick` **no corpo**. A regra do sinal `facebookPixel` (igual à do Blacklight) exige `ev=` na **URL**, por isso o sinal ficou `false`. O domínio foi contado normalmente nos critérios 1 e 2 (cookie `fr`).
5. **CNN: o Blacklight parou na tela “Legal Terms and Privacy”**, um bloqueio só para visitantes dos EUA (no Firefox, a partir do Brasil, `pubads.g.doubleclick.net` já é chamado em t+0,0 s). `screenshots/` só tem `2.jpeg`, e `html/1.html` e `html/2.html` contêm o modal “By clicking Agree, you agree to the Terms of Use…”. O `requests.har` do Blacklight tem 114 requisições e 0 a doubleclick/googlesyndication, contra 59 + 49 requisições contadas pelo plugin (`cnn.json`; o `cnn.har` tem 65 + 49). Os números do Blacklight para a CNN não representam a página depois do aceite.
6. **CNN: ETP do Firefox.** `m.stripe.network/inner.html` e `bounceexchange.com` foram cancelados com `NS_ERROR_FINGERPRINTING_URI`, por isso o cookie `m` do Stripe (T2 do Blacklight) não existe no Firefox. Os dois domínios ficam fora do critério 1 (57 = 59 − 2).
7. **Domínios do mesmo grupo contados como terceiros** nos dois métodos: jsuol/imguol/uol.com (UOL); mlcdn.com.br/magalu.com (Magalu); cnn.io, max.com, discomax.com, turner.com, warnermediacdn.com etc. (CNN). O próprio Blacklight marca `tm.jsuol.com.br` como cookie de 3ª parte.
8. **Session recording e key logging medem coisas diferentes.** O Blacklight usa lista de hosts e detecta a exfiltração do texto digitado. O PrivacyLens aponta a capacidade (listener de 3ª parte). No Magalu, o key logging do Blacklight é a busca com autocompletar (`POST federation.magazineluiza.com.br/graphql`), que é **1ª parte** e fica fora do critério 9 do PrivacyLens.

### 3.2 Comparação com o uBlock Origin

Fonte: Logger do uBlock Origin exportado em `evidencias/sites/<site>/<site>_ublock.txt` (perfil separado, lista padrão; print em `<site>_ublock.png`). Uma entrada conta como bloqueada quando tem a linha `--`. Domínios agrupados por eTLD+1, como nas outras análises.

| Site | Entradas no log | Bloqueadas | Domínios bloqueados | Bloqueados e apontados pelo PrivacyLens e pelo Blacklight | Bloqueados e apontados só pelo PrivacyLens | Bloqueados e vistos só pelo Blacklight | Só no uBlock |
|---|---|---|---|---|---|---|---|
| UOL | 347 | **43** | 11 (youtube.com 18, doubleclick.net 8, jsuol.com.br 6, chartbeat.com 3…) | chartbeat.com, doubleclick.net, imguol.com.br, jsuol.com.br, mrf.io, permutive.app, scorecardresearch.com, youtube.com | cxense.com, google-analytics.com | imasdk.googleapis.com | — |
| Magazine Luiza | 491 | **32** | 15 (tiktok.com 11, googletagmanager.com 4, ads-twitter.com, google.com, doubleclick.net, go-mpulse.net 2 cada…) | googletagmanager.com, hotjar.com | ads-twitter.com, bing.com, btg360.com.br, creativecdn.com, datadoghq-browser-agent.com, doubleclick.net, facebook.net, go-mpulse.net, google.com, pinimg.com, questionpro.com, tiktok.com, visualwebsiteoptimizer.com | — | — |
| CNN | 713 | **47** | 22 (doubleclick.net 10, cnn.com 6, googlesyndication.com 4, max.com 3, chartbeat.com 3…) | imasdk.googleapis.com, optimizely.com | adnxs.com, adsafeprotected.com, btloader.com, chartbeat.com, cxense.com, doubleclick.net, google.com, googlesyndication.com, max.com, permutive.app, rezync.com, rubiconproject.com, script.ac, stickyadstv.com, ugdturner.com, wknd.ai, zqtk.net | — | fwmrm.net, tremorhub.com |

**Análise**

1. **Quase todo domínio bloqueado pelo uBlock já tinha sido apontado pelo PrivacyLens**, com três exceções: `imasdk.googleapis.com` no UOL (SDK de anúncio em vídeo, que o Blacklight também viu) e `fwmrm.net` (FreeWheel) e `tremorhub.com` na CNN, servidores de anúncio em vídeo. Nenhum deles foi chamado no carregamento medido pelo PrivacyLens, porque o anúncio em vídeo varia a cada carregamento. O inverso não vale: o PrivacyLens viu 73/33/59 terceiros, e o uBlock bloqueou pedidos de só 11/15/22 domínios.
2. **O uBlock corta a cadeia no começo.** Bloquear `doubleclick.net`, `googlesyndication.com` e `rubiconproject.com` impede que o leilão (header bidding) rode, e com isso os parceiros de cookie sync nem chegam a ser chamados. Por isso eles não aparecem como bloqueados: o `--` só registra o pedido barrado, não os que deixaram de existir. Os 63 (UOL), 18 (Magalu) e 40 (CNN) terceiros do PrivacyLens que não aparecem como bloqueados são, em boa parte, esses pedidos que nunca foram feitos, e não rastreadores que o uBlock deixaria passar.
3. **O uBlock também bloqueia primeira parte e domínios do mesmo grupo**, que o Blacklight não conta como ad tracker: `cnn.com` (6 pedidos: `||z.cdp-dev.cnn.com^` 2 e `lightning.cnn.com/launch/`, o Adobe Launch, 4), `max.com` (3 pedidos, filtro `||media.max.com/*/main.mpd^$from=cnn.com`, que barra o manifesto do player ao vivo da CNN LATAM) e `ugdturner.com` (grupo Warner Bros. Discovery); `jsuol.com.br` (`||tm.jsuol.com.br^`, 4) e `imguol.com.br` (grupo UOL).
4. **Concordância com o Blacklight**: é alta no UOL (9 dos 11 domínios bloqueados estão também no teste 1 ou no tráfego do Blacklight) e baixa no Magalu e na CNN, pelas limitações do Blacklight nesses sites (403 e modal de termos, seção 3.1).
5. **Limitação:** o Logger só registra a janela gravada. O uBlock rodou num perfil separado e em outro carregamento, então as contagens são por sessão, e não por página comparável 1:1.

---

## 4. Score de privacidade (entregável 4)

### 4.1 Aplicação aos 3 sites

As penalidades foram **recalculadas** a partir dos dados brutos de cada JSON (listas de terceiros, cookies, storage, canvas, sync e indícios), com as fórmulas de `background/score.js`, e conferem com o export. Formato: valor observado → penalidade.

| # | Critério (peso) | UOL | Magazine Luiza | CNN |
|---|---|---|---|---|
| 1 | Domínios de 3ª parte (15) | 73 → **15** | 33 → **15** | 57 → **15** |
| 2 | Cookies de 3ª parte persistentes (20) | 62 → **20** | 16 → **20** | 26 → **20** |
| 3 | Cookies de 1ª parte > 90 dias (5) | 18 → **5** | 31 → **5** | 41 → **5** |
| 4 | Storage de 3ª parte em iframe (10) | 1 (`www.google.com`) → **3** | 0 → **0** | 1 (`a125375509.cdn.optimizely.com`) → **3** |
| 5 | localStorage de 1ª parte (5) | 30 KB → **0,6** | 3 KB → **0,1** | 73 KB → **1,5** |
| 6 | Canvas fingerprinting (15) | não → **0** | sim (script anti-bot de 1ª parte) → **15** | não → **0** |
| 7 | Cookie sync / bounce (15) | 14 sync + 3 IDs compartilhados → **15** | 0 → **0** | 4 sync + 1 ID compartilhado → **15** |
| 8 | Hijacking / hook (10) | 0 → **0** | 4 hooks **altos** (3 do Datadog RUM em fetch/XHR, 1 do VWO em `document.cookie`) → **10** | 1 polling (`…cnn.latam…media.max.com`) → **5** |
| 9 | Session recording / keylogging (5) | sim (5 terceiros) → **5** | sim (Hotjar + 4) → **5** | sim (4 terceiros) → **5** |
| | **Total de penalidades** | **63,6** | **70,1** | **69,5** |
| | **Score / nota** | **36 D** | **30 D** | **31 D** |

Os valores conferidos antes (UOL 36 D, Magalu 30 D, CNN 31 D) estão **confirmados**. Na CNN, 100 − 69,5 = 30,5, que o `Math.round` do JavaScript arredonda para 31. Um recálculo com arredondamento bancário (Python) daria 30, e a nota continua D.

### 4.2 Comparação crítica com o Blacklight

**Onde concordam**

- **Magazine Luiza, canvas (critério 6 x teste 3):** o mesmo script, pelo mesmo caminho. É a concordância mais forte, porque os critérios de canvas são diferentes (o PrivacyLens exige canvas oculto, e o Blacklight exclui scripts que usam `save`/`restore`) e mesmo assim apontam o mesmo arquivo. O script Azion, que também lê canvas, foi descartado pelo PrivacyLens (texto de 5 caracteres, 1 cor). É o filtro de falso positivo funcionando.
- **Magazine Luiza, Hotjar (critério 9 x teste 4)**, com ressalva: os dois viram páginas diferentes e contas Hotjar diferentes (`hotjar-557368.js` na central de ajuda, no Blacklight; `hotjar-4936838.js` na loja, no PrivacyLens). A concordância é no nível do site, e não do mesmo script.
- **UOL, GA remarketing (sinal informativo x teste 7):** a mesma propriedade `G-BS4Q6LCGB1`.
- **UOL, ad-tech grande (critério 1 x teste 1):** doubleclick, googlesyndication, adnxs, criteo, rubiconproject, scorecardresearch, smartadserver e seedtag aparecem nos dois. São 36 domínios em comum.

**Onde divergem e por quê**

1. **O PrivacyLens penaliza mais do que o Blacklight mostra nos três sites, e isso é estrutural.** O critério 1 conta **todo** terceiro, e o teste 1 só conta o que casa com as listas de publicidade. O critério 2 conta cookies **particionados** (56 dos 62 no UOL; os outros 6 não tiveram o armazenamento confirmado). O Blacklight não aceita banners, e o protocolo do PrivacyLens aceita.
2. **A ordem dos sites se inverte**, mas só no UOL a comparação é válida, pelas limitações do item 3. Para o Blacklight, o UOL é o pior (21 ad trackers, 14 cookies, pixel, remarketing) e a CNN é quase limpa (2 cookies). Para o PrivacyLens, o UOL tem a **melhor** nota (36) e o Magalu a pior (30). Motivos:
   - os critérios 1, 2, 3 e 9 **saturam** nos três sites (15 + 20 + 5 + 5 = 45 pontos iguais para todos), então quem diferencia é canvas, hijacking, sync e, em menor grau, storage;
   - o Magalu perde 25 pontos com canvas (15) e hooks do Datadog/VWO (10), vetores que o Blacklight não pontua como “ad tracker”;
   - no UOL, o hijacking é 0.
3. **A limitação do Blacklight em 2 dos 3 sites inviabiliza a comparação numérica.** O Magalu deu 403 (bot) e a CNN parou no modal de termos. Nesses casos o Blacklight **subestima** a página real, e a divergência não é erro do PrivacyLens.
4. **Diferenças de método que o score não resolve:** página única x home + interna (pixel do FB no UOL), key logging de 1ª parte (Magalu), ETP do Firefox (Stripe na CNN) e o falso negativo do sinal de pixel quando o evento vai no corpo do POST.

**Limitação do score evidenciada pelos dados.** Com os pesos atuais, três sites muito diferentes caem na mesma faixa D (30 a 36), porque 4 critérios (45 dos 100 pontos) batem no teto nos três sites. Isso reforça a decisão de exibir sempre a quebra por critério (METODOLOGIA 8, item 12). Uma revisão futura poderia subir os tetos dos critérios 2 e 3 ou usar escala logarítmica também para cookies, para diferenciar 16 de 62 cookies de terceiros.

---

## Observações e limitações

- **Prints com lista parcial**: em request-blocking (seção JS), storage-partitioning (fim da lista) e js-leaks (lista “Properties Added”), parte do resultado fica fora da área visível do print.
- **ETP e rastreadores sociais**: a METODOLOGIA (seção 6, testes 6 e 7) supõe que o ETP Padrão bloqueia o pixel do Facebook. As evidências mostram o contrário em janela normal: `facebook.com/tr` respondeu 200 (Magalu: 2 `POST www.facebook.com/tr/`, com o cookie `fr` gravado; DDG tracker-reporting-img: `GET facebook.com/tr` → 200), e o GA remarketing disparou no UOL e no Magalu (`googleRemarketing: true`). Onde o sinal `facebookPixel` ficou falso, a causa foi a regra do `ev=` na URL, não o ETP.
- **Protocolo nos testes do DDG**: js-leaks, fingerprinting, bounce-tracking, query-parameters e os `_com-bloqueio` têm cookies pré-existentes; os testes rodaram em sequência, sem perfil limpo entre eles (METODOLOGIA 7, item 3). Isso não muda os scores, porque cookies pré-existentes não contam.
- **HAR públicos**: os HAR do Firefox são **sanitizados** (cookies, tokens, Authorization e o IP do usuário viram `[REMOVIDO]`), e os originais ficam só na máquina local (`*_original.har`, no `.gitignore`). Nas cópias do Blacklight só o IP do usuário foi removido; o restante é a sessão anônima do crawler do The Markup, mantida como foi baixada.
