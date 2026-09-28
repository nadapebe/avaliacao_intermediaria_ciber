# Metodologia do PrivacyLens

Este documento descreve **o que** o PrivacyLens mede, **como** cada medida é obtida e **como** elas são combinadas na pontuação de privacidade da página. Também explica como a pontuação se relaciona com os 7 testes do Blacklight (The Markup), qual protocolo de medição foi seguido e quais são as limitações do método.

O código de referência de cada item está indicado entre parênteses.

---

## 1. Escala

A pontuação vai de **0 a 100, onde 100 = melhor privacidade**. Ela parte de 100 e subtrai uma penalidade por critério. Os pesos somam **exatamente 100**, então uma página que atinge a penalidade máxima em todos os critérios fica com 0. Cada penalidade é arredondada a uma casa decimal antes da soma, e o resultado final é arredondado para inteiro (`background/score.js`).

| Nota | Faixa |
|---|---|
| **A** | 80 – 100 |
| **B** | 60 – 79 |
| **C** | 40 – 59 |
| **D** | 20 – 39 |
| **E** | abaixo de 20 |

Todas as métricas são **por carregamento de página**. O registro da aba é zerado a cada navegação de topo, porque o enunciado pede o que é injetado *no carregamento* da página, e não o acumulado do perfil do navegador (`background/state.js`, `background/requests.js`).

---

## 2. Critérios, pesos e justificativa

| # | Critério | Peso | Cálculo | Justificativa |
|---|---|---|---|---|
| 1 | Domínios de 3ª parte contatados | **15** | `min(15, 3·log2(1+n))` | Superfície de exposição: cada terceiro recebe IP, User-Agent e a página visitada. A escala é logarítmica porque o 1º terceiro pesa muito mais que o 31º. A penalidade atinge o teto em 31 terceiros. |
| 2 | Cookies de 3ª parte persistentes | **20** | `min(20, 4·n)` | Identificador estável entre sites, o mecanismo clássico de rastreamento. |
| 3 | Cookies de 1ª parte persistentes > 90 dias | **5** | `min(5, 1·n)` | Cookie de primeira parte usado como identificador do visitante (ex.: `_ga`, `_fbp`) e lido por scripts de terceiros embutidos. |
| 4 | Storage HTML5 de 3ª parte (em iframe) | **10** | `min(10, 3·n)` | Persistência fora do ciclo de vida do cookie: sobrevive à limpeza de cookies e escapa das preferências de cookie. |
| 5 | Volume de localStorage de 1ª parte | **5** | `min(5, bytes / 50 KB)` | Indicador de supercookie ou de estado excessivo guardado no navegador. |
| 6 | Canvas fingerprinting | **15** | binário (0 ou 15) | Identificação sem consentimento e sem estado: não é removida limpando cookies e o usuário não consegue evitar. |
| 7 | Cookie sync / bounce tracking | **15** | 8 por sync distinto, +15 se houver bounce, teto 15 | Une as identidades do usuário em domínios diferentes e anula o isolamento de cookies por site. |
| 8 | Indícios de hijacking / hook | **10** | 5 por indício de severidade média ou alta, teto 10 | Vai além de rastreamento: é controle do navegador (canal de comando, interceptação de chamadas). |
| 9 | Session recording / keylogging | **5** | binário (0 ou 5) | Captura o conteúdo digitado e os movimentos do usuário, não só metadados. |
| | **Total** | **100** | | |

> **Correção em relação à proposta inicial do enunciado:** a tabela inicial atribuía peso 20 ao critério 1, com a fórmula `5·log2(1+n)`, e os pesos somavam 105. Isso contradizia a regra "soma máxima das penalidades = 100". Foram feitos dois ajustes no critério 1:
>
> - o peso passou para **15**, porque é o critério que mais se sobrepõe aos demais: todo cookie ou script de terceiro já implica um domínio de terceiro contatado;
> - o coeficiente passou para **3**. Assim a penalidade só atinge o teto em 31 terceiros, como diz a própria justificativa. Com `5·log2(1+n)` e teto 15, o teto viria em 7 terceiros, e o critério não diferenciaria sites reais.
>
> Os outros critérios continuam como estavam.

### 2.1 Definição exata de cada contagem

1. **n (critério 1)** é o número de domínios registráveis (eTLD+1) diferentes do domínio da página que receberam ao menos uma requisição. A comparação é sempre por eTLD+1 (Public Suffix List): `s1.uol.com.br` em `www.uol.com.br` é primeira parte, e `googletagmanager.com` é terceira. Não contam os domínios cujas requisições foram **todas** canceladas antes de sair do navegador, porque nenhum dado chegou a eles. O cancelamento pode vir da lista de bloqueio do próprio PrivacyLens ou do Enhanced Tracking Protection do Firefox (erros `NS_ERROR_TRACKING_URI`, `NS_ERROR_SOCIALTRACKING_URI`, `NS_ERROR_FINGERPRINTING_URI`...).
2. **Cookies de 3ª parte persistentes:** cookies *injetados neste carregamento* e *efetivamente armazenados*. Contam os que vêm pelo header `Set-Cookie` e os escritos por JavaScript. Ficam de fora:
   - cookies que já existiam antes da visita;
   - cookies que o Firefox rejeitou (ex.: bloqueados pelo Enhanced Tracking Protection).

   Os cookies de terceiros que o Firefox **particiona** (Total Cookie Protection) continuam contando: eles existem e identificam o usuário, só que dentro de um site.

   O cookie é **de terceira parte** quando o eTLD+1 do seu domínio difere do da página. É **persistente** quando tem `Max-Age > 0` ou `Expires` no futuro (o `Max-Age` tem precedência).
3. **Cookies de 1ª parte > 90 dias:** mesmo filtro do item anterior, com domínio de primeira parte e duração acima de 90 dias.
4. **Storage de 3ª parte:** origens de iframe de outro eTLD+1 que tinham ao menos uma chave em `localStorage` ou `sessionStorage`, ou um banco IndexedDB. A coleta é feita pelo content script em todos os frames (`content/content.js`) e pelo hook de `indexedDB.open` (`content/inject.js`). A contagem é por origem: `a.x.com` e `b.x.com` contam como duas.
5. **Volume de localStorage de 1ª parte:** soma do maior tamanho observado de `localStorage` das origens de primeira parte, em bytes UTF-16 (2 bytes por caractere, a unidade da cota de Web Storage).
6. **Canvas fingerprinting:** ao menos uma leitura de canvas que satisfaça todas as condições da seção 3.
7. **Cookie sync:** pares distintos A→B do tipo *sincronismo* (valor de cookie do terceiro A encontrado na URL de uma requisição ao terceiro B) mais os *IDs compartilhados*: o mesmo UUID, ou hex de 16 ou mais caracteres, em parâmetros de requisições para dois ou mais terceiros. O **vazamento de ID de primeira parte** (ex.: o client id do `_ga` enviado ao Google Analytics) aparece no relatório mas **não é penalizado aqui**. Ele está em praticamente todo site com analytics, e o dano já é contado pelos critérios 1 e 3. O **bounce** é o padrão A → T → B descrito na seção 4.
8. **Hijacking / hook:** indícios de severidade *média* ou *alta*:
   - WebSocket para terceiro;
   - polling persistente;
   - hook de API nativa atribuído a terceiro;
   - assinatura BeEF.

   Os indícios de severidade *baixa* (script injetado após o `load`, hook de primeira parte ou sem autoria, `hook.js` sem polling) aparecem no relatório mas não penalizam, porque bibliotecas legítimas (Sentry, New Relic, GTM, gestores de consentimento) produzem esses sinais.
9. **Session recording / keylogging:** algum destes:
   - listener de teclado ou digitação registrado por script de terceira parte;
   - o mesmo terceiro escutando teclado e movimento do mouse;
   - requisição a host conhecido de gravação de sessão (`background/hijack.js`): Hotjar (`hotjar.com`, `hotjar.io`), Microsoft Clarity (`clarity.ms`), FullStory (`fullstory.com`), Smartlook (`smartlook.com`, `smartlook.cloud`), Mouseflow (`mouseflow.com`), Lucky Orange (`luckyorange.com`, `luckyorange.net`), Inspectlet (`inspectlet.com`), LogRocket (`logrocket.com`, `lr-ingest.io`, `lr-in.com`), Contentsquare (`contentsquare.net`), Quantum Metric (`quantummetric.com`), SessionCam (`sessioncam.com`), ClickTale (`clicktale.net`), Decibel (`decibelinsight.net`) e Yandex Metrica/Webvisor (`mc.yandex.ru`, `mc.yandex.com`, `mc.webvisor.org`).

### 2.2 Exemplo de cálculo

Uma página com as características abaixo:

- 12 terceiros;
- 3 cookies de terceira parte persistentes;
- 2 cookies de primeira parte de 400 dias;
- 1 iframe de terceiro com localStorage;
- 20 KB de localStorage próprio;
- canvas fingerprinting;
- 1 cookie sync;
- nenhum hook;
- Hotjar.

| Critério | Observado | Penalidade |
|---|---|---|
| Terceiros | 12 | min(15, 3·log2 13) = min(15, 11,1) = **11,1** |
| Cookies 3ª persistentes | 3 | min(20, 12) = **12** |
| Cookies 1ª > 90 dias | 2 | **2** |
| Storage 3ª | 1 | **3** |
| localStorage 1ª | 20 KB | 20/50 = **0,4** |
| Canvas | sim | **15** |
| Sync / bounce | 1 sync | **8** |
| Hijacking | 0 | **0** |
| Session recording | sim | **5** |
| **Total** | | **56,5** → score **44** → nota **C** |

O popup do plugin (aba *Resumo*) e o JSON exportado mostram essa mesma quebra para cada página, com o valor observado, a penalidade, a fórmula e a justificativa de cada linha.

---

## 3. Critério de canvas fingerprinting

Uma leitura de canvas é marcada como fingerprinting quando **todas** as condições abaixo são verdadeiras (`content/inject.js`):

1. o canvas tem pelo menos **16×16 px**;
2. houve escrita de texto (`fillText`/`strokeText`) com pelo menos **10 caracteres distintos** ou com **2 ou mais cores**;
3. a imagem foi **lida de volta**: `toDataURL`/`toBlob`, ou `getImageData` de uma área de pelo menos 16×16;
4. o canvas **não estava exibido** ao usuário: fora do DOM, com `display:none`, `visibility:hidden` ou opacidade 0 no próprio elemento, com tamanho zero, ou posicionado inteiramente acima ou à esquerda da área visível.

As condições 1 a 3 são as de **Englehardt & Narayanan (2016)**, *Online Tracking: A 1-million-site Measurement and Analysis*, a mesma base usada pelo Blacklight. Por isso a comparação com o Blacklight é defensável. A condição 4 é uma **adição do PrivacyLens** e é usada **no lugar** da exclusão do artigo (scripts que chamam `save`/`restore`/`addEventListener`, que o Blacklight aplica) como filtro de falsos positivos. O motivo é que um canvas que o usuário está vendo (gráfico, jogo, editor) não é fingerprinting.

O script responsável é identificado pela pilha de chamadas (`new Error().stack`) no momento da leitura.

Também são registrados, como **vetores adicionais de fingerprinting** (sem peso no score, exibidos na aba *Fingerprint*):

- WebGL: `UNMASKED_VENDOR/RENDERER` e varredura de 20 ou mais parâmetros;
- áudio (`OfflineAudioContext`, osciladores, compressores);
- WebRTC (`RTCPeerConnection`);
- `navigator.hardwareConcurrency`, `plugins`, `languages` e `deviceMemory`;
- `screen`;
- enumeração de fontes: `measureText` com 20 ou mais famílias diferentes;
- Battery API, quando existir.

---

## 4. Rastreamento entre domínios (`background/tracking.js`)

- **Cookie sync.** O plugin mantém um índice `valor → {domínio, nome}` com todo cookie de valor com cara de identificador conhecido na aba. As fontes são os cookies injetados, o snapshot e os valores enviados no header `Cookie`. Cada requisição a um terceiro B é varrida em:
  - query string;
  - segmentos do path;
  - fragmento;
  - valores após `decodeURIComponent`;
  - query strings aninhadas;
  - candidatos base64.

  Encontrar o valor de A na URL de B, com A ≠ B, caracteriza **sync A→B**. Timestamps, datas ISO, valores curtos e flags (`true`, `undefined`...) são descartados. Cookies e parâmetros de consentimento (TCF/GPP/CCPA, como `euconsent-v2` e `gdpr_consent`) também são ignorados: o mesmo texto é repassado a todos os anunciantes por exigência legal e não é identificador de usuário.
- **Bounce tracking.** O padrão é A → T → B, com o eTLD+1 de T diferente do de A e do de B, e T com estado na passagem: grava cookie (`Set-Cookie`/`document.cookie`) ou recebe o cookie de uma visita anterior. Há duas formas:
  - **no servidor:** saltos 3xx do documento de topo (redirecionamentos internos do navegador, como o upgrade HSTS, são ignorados);
  - **no cliente:** T redireciona por JavaScript ou meta refresh em até 10 s, **sem nenhuma interação do usuário** (clique, tecla ou toque) e partindo da própria página T.

  A página *bounce-tracking* do DuckDuckGo usa a forma no cliente: `bounce.html` grava `bounceUID` e redireciona.
- **Link decoration.** O plugin procura estes parâmetros nas URLs de navegação e nas requisições a terceiros:
  - `gclid`, `fbclid`, `msclkid`, `ttclid`, `twclid`, `igshid`, `_ga`, `_gl`, `mc_eid`, `yclid`;
  - `dclid`, `gbraid`, `wbraid`, `_hsenc`, `_hsmi`, `mkt_tok`, `srsltid`;
  - qualquer `utm_*`;
  - a lista fechada usada pela página *Query parameters* do DuckDuckGo: `fb_source`, `fb_ref`, `fb_action_ids`, `fb_action_types`, `action_object_map`, `action_type_map`, `action_ref_map`, `gs_l`, `ga_source`, `ga_medium`, `ga_term`, `ga_content`, `ga_campaign`, `ga_place`, `hmb_campaign`, `hmb_source` e `hmb_medium`.

  Eles são exibidos no relatório, sem peso próprio no score.

---

## 5. Hijacking e hook (`background/hijack.js`, `content/inject.js`)

| Indício | Critério | Severidade |
|---|---|---|
| WebSocket | conexão `ws/wss` para terceiro (webRequest + construtor instrumentado, com o script que abriu) | média |
| Polling persistente | mesma URL (host + caminho) de terceiro chamada 5 ou mais vezes, intervalo mediano abaixo de 15 s, 70% ou mais dos intervalos dentro de ±30% da mediana, ao longo de 30 s ou mais | média |
| Hook de API nativa | referência de `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `addEventListener`, `pushState`, `window.open`, `document.cookie` ou `Function.prototype.toString` diferente da guardada no `document_start`, comparada no `DOMContentLoaded`, no `load` e 3 s depois, inclusive por sombreamento no próprio objeto | alta se o mesmo terceiro também faz polling, WebSocket ou escuta teclado; média se atribuído a terceiro; baixa se de primeira parte ou sem autoria |
| Script injetado | `<script src>` de terceiro adicionado ao DOM depois do `load` | baixa |
| Assinatura BeEF | script de terceiro chamado `hook.js` + polling persistente para o mesmo host | alta |

O script responsável por um hook é identificado quando o hook repassa a chamada à função original: essa chamada passa pelo wrapper do PrivacyLens, cuja pilha revela o autor. Para o laboratório com BeEF, uma origem diferente no mesmo IP ou em `localhost` (ex.: página em `127.0.0.1:8000`, BeEF em `127.0.0.1:3000`) também é tratada como externa. Eventos que um iframe de outro site produz sobre ele mesmo (ex.: os atalhos de teclado do player do YouTube embutido) são descartados.

**Instrumentação do próprio plugin.** O PrivacyLens também faz hooking para medir. As referências são guardadas **depois** da própria instrumentação, e os wrappers do plugin ficam num mapa interno. Assim eles ficam fora da detecção. `Function.prototype.toString` devolve para eles o texto da função nativa original, e nenhuma propriedade é criada em `window`. A página *js-leaks* do DuckDuckGo, que procura exatamente esses vazamentos de extensões, não encontra diferença com e sem o plugin.

---

## 6. Correspondência com os 7 testes do Blacklight

**Como o Blacklight coleta**, conforme a metodologia publicada pelo The Markup e o código do `blacklight-collector`:

- usa um Chromium headless (Puppeteer) com perfil limpo;
- visita a página inicial e uma página interna escolhida ao acaso;
- **não aceita banners de consentimento**;
- rola a página e digita textos predefinidos nos campos, sem enviar formulários.

O PrivacyLens observa **um carregamento** de uma sessão real no Firefox. A versão atual do Blacklight tem mais testes, como os pixels do X e do TikTok, mas o enunciado usa os **7 originais**.

A tabela diz, para cada teste, onde a concordância é esperada e onde a divergência é **estrutural**, ou seja, vem do método e não de erro.

| Teste do Blacklight | Como o Blacklight mede | Critério do PrivacyLens | Concordância esperada | Divergência estrutural |
|---|---|---|---|---|
| **1. Ad trackers** | Requisições de terceira parte que casam com EasyList/EasyPrivacy, filtradas para domínios das categorias de rastreamento motivado por publicidade (*Ad Motivated Tracking*) do *Tracker Radar* do DuckDuckGo | Critério 1 (todos os terceiros) + classificação do Firefox (`urlClassification`) na aba *Terceiros* | Os grandes (doubleclick, google-analytics, facebook, criteo...) aparecem nos dois | O PrivacyLens conta **todos** os terceiros (CDNs, fontes, APIs), e o Blacklight só os que estão nas listas. No Firefox, o ETP bloqueia parte dos rastreadores antes da conexão; esses não contam no critério 1. No Chromium do Blacklight eles são carregados. |
| **2. Cookies de terceira parte** | **Todos** os cookies cujo domínio difere do site, via `Set-Cookie` e `document.cookie`, de sessão ou persistentes. O Tracker Radar só identifica o dono | Critério 2 | Cookies persistentes de ad-tech (`IDE`, `uid`, `_fbp` de terceiro...) | O Blacklight conta todos os cookies de terceiros, inclusive os de sessão. O PrivacyLens penaliza só os **persistentes e efetivamente armazenados**. O ETP do Firefox rejeita cookies de rastreadores que o Chromium aceita. Os particionados pelo Total Cookie Protection continuam contando no PrivacyLens. |
| **3. Canvas fingerprinting** | Instrumentação das APIs de canvas com a heurística de Englehardt & Narayanan, incluindo a exclusão de scripts que chamam `save`/`restore`/`addEventListener` | Critério 6 | Mesma base de critério, então os mesmos scripts devem ser apontados | Os critérios são **diferentes**, e não só um mais restritivo que o outro. O PrivacyLens exige canvas oculto (condição 4), mas não aplica a exclusão por `save`/`restore`/`addEventListener`. Scripts que só rodam em certas condições (geografia, user-agent, interação) podem aparecer em um e não no outro. |
| **4. Session recording** | Requisições cuja URL (host + caminho) contém uma das substrings da lista de provedores de Princeton (2017, *No Boundaries*): Yandex Metrica/Webvisor, FullStory, Hotjar, SessionCam, UserReplay, ClickTale, Smartlook, Decibel, Quantum Metric, Inspectlet, Mouseflow, LogRocket, SaleMove, Lucky Orange, VWO | Critério 9: hosts conhecidos + listeners de teclado e mouse do mesmo terceiro | Hotjar, FullStory, Smartlook, Mouseflow etc. nos dois | O Blacklight casa substrings de caminho específicas (ex.: `fullstory.com/s/fs.js`, `mc.yandex.ru/metrika/tag.js`), e o PrivacyLens casa qualquer requisição ao host. Microsoft Clarity e Contentsquare estão só na lista do PrivacyLens. UserReplay, SaleMove e VWO estão só na do Blacklight. O PrivacyLens também aponta terceiros desconhecidos que escutam teclado e mouse. |
| **5. Key logging** | Digita textos predefinidos nos campos e verifica se esse texto aparece, em claro ou como base64/MD5/SHA-256/SHA-512, no **corpo de requisições POST a qualquer servidor** antes do envio do formulário | Critério 9 (listener de teclado ou digitação registrado por script de terceiro) | Sites onde um terceiro escuta a digitação e envia o conteúdo | **Método diferente:** o Blacklight detecta a **exfiltração** do texto, e o PrivacyLens detecta a **capacidade**: o listener instalado por terceiro. Um listener que não envia nada é apontado só pelo PrivacyLens. Um envio feito por script de primeira parte, ou para o próprio site, é apontado só pelo Blacklight. |
| **6. Facebook Pixel** | Requisições ao Facebook com o parâmetro `ev` do pixel (na prática `facebook.com/tr?ev=...`), registrando os eventos e os campos de correspondência avançada (`ud[...]`) | Sinal informativo `facebookPixel` (mesma regra, inclusive a exclusão do evento `Microdata`; sem peso) + `facebook.com`/`facebook.net` nos critérios 1 e 2 | Presença do pixel | O PrivacyLens não dá peso próprio ao pixel. Ele já é contado como terceiro, e seus cookies e parâmetros entram nos critérios 1, 2 e 7. Nas medições, o ETP no modo Padrão (janela normal) não bloqueou o pixel: `facebook.com/tr` respondeu 200 e o cookie `fr` foi gravado. Quando o sinal fica falso com o pixel presente, a causa é a regra, que exige `ev` na URL: o pixel pode mandar o evento no corpo de um POST. |
| **7. Google Analytics "Remarketing Audiences"** | URL de `stats.g.doubleclick` com um ID de propriedade (`UA-`, `G-` ou `AW-`) | Sinal informativo `googleRemarketing` (mesma regra + o endpoint `google.*/ads/ga-audiences`, adição do PrivacyLens; sem peso) + critérios 1 e 3 | Presença do endpoint | O PrivacyLens não dá peso próprio ao sinal, porque o domínio e os cookies já entram nos critérios 1 e 3. Nas medições, o ETP no modo Padrão não bloqueou o endpoint (`googleRemarketing: true` no UOL e no Magalu). O client id do `_ga` aparece como *vazamento de ID de primeira parte* no relatório. |

**Resumo das divergências de método:**

1. **Navegador.** O Firefox com ETP bloqueia requisições e rejeita cookies de rastreadores que o Chromium do Blacklight deixa passar, então o PrivacyLens tende a ver **menos** terceiros efetivamente contatados e **menos** cookies de terceiros armazenados.
2. **Critério.** O PrivacyLens conta todos os terceiros e todos os vetores, e o Blacklight conta o que está em suas listas.
3. **Consentimento e interação.** O Blacklight nunca aceita o banner de consentimento. No protocolo do PrivacyLens (seção 7) o banner é aceito, o que dispara rastreadores que só carregam depois do consentimento.
4. **Páginas.** O Blacklight agrega a página inicial e uma página interna. O PrivacyLens mede um carregamento de uma única página.
5. **Momento.** Os dois rodam em momentos diferentes, e anúncios e leilões mudam a cada carregamento.

---

## 7. Protocolo de medição

Para que os números sejam reproduzíveis e comparáveis, as medições do relatório seguem este protocolo:

1. **Perfil limpo do Firefox** (`about:profiles` → criar novo perfil), sem outras extensões. Bloqueadores como o uBlock Origin cancelariam requisições e injetariam *scriptlets* que o PrivacyLens apontaria como hook. A comparação com o uBlock Origin é feita separadamente, no Logger do próprio uBlock.
2. **Proteção contra rastreamento no modo Padrão** do Firefox, o padrão de fábrica. O modo não vai no JSON exportado; ele é registrado no relatório, porque altera o que é bloqueado.
3. **Perfil novo, ou dados do site apagados, em janela normal** para cada site. Para apagar os dados do site: `about:preferences#privacy` → *Cookies e dados de sites* → *Gerenciar dados*. Isso garante a **primeira visita**. Uma revisita teria cookies pré-existentes, que não contam como injetados, e daria uma nota melhor. A janela privativa **não** é usada, porque nela o modo Padrão também bloqueia "conteúdo de rastreamento". Isso esconderia rastreadores que o Blacklight vê.
4. DevTools aberto na aba *Rede*, com o cache desativado, antes de carregar a página. Assim o HAR registra todo o tráfego.
5. **Banner de cookies aceito nos primeiros 10 s**, porque cookies gravados por JavaScript só são atribuídos até 30 s após o início da navegação. Depois, rolagem até o fim da página e **espera de 30 s** antes de exportar. O snapshot de cookies roda no `load` e 5 s depois, e os indícios de polling exigem 30 s de observação.
6. Com a página ainda aberta, salvar o HAR, exportar o JSON do PrivacyLens e fazer os prints das abas do plugin.
7. No mesmo dia, rodar o Blacklight na mesma URL e registrar os bloqueios do uBlock Origin num perfil separado.

A **aplicação do score aos 3 sites reais** fica no relatório em PDF: tabela por critério, os 7 resultados do Blacklight lado a lado e a análise de onde concordam e onde divergem. Os números vêm dos JSONs exportados, que estão em `evidencias/sites/`.

---

## 8. Limitações metodológicas

1. **Atribuição de cookies sem `tabId`.** `cookies.onChanged` não informa a aba de origem. Mitigação: o evento só é atribuído a uma aba dentro da janela de carregamento (30 s após o início da navegação) **e** cujo tráfego já contatou o eTLD+1 do cookie. Se o cookie é particionado, também é exigido que a página seja o site da partição. Duas abas carregando o mesmo domínio ao mesmo tempo recebem ambas o evento.
2. **Public Suffix List embarcada.** A lista (`lib/psl-data.js`) foi gerada em **2026-09-27** a partir da lista oficial (10.037 regras normais, 289 curinga e 8 de exceção, seções ICANN e PRIVATE, com as regras IDN em punycode). Sufixos criados depois dessa data não são reconhecidos até a lista ser regerada.
3. **Heurística de canvas.** Um fingerprinting feito num canvas visível ao usuário não é marcado (condição 4). Iframes `about:blank` vazios não recebem o script de instrumentação a tempo: uma página pode pegar funções "limpas" de dentro deles e escapar da instrumentação. Workers e service workers não são instrumentados.
4. **Detector, não bloqueador.** Por padrão o PrivacyLens só observa. As páginas de teste do DuckDuckGo reportam o que o **navegador ou a extensão bloqueou**, então a divergência com elas é esperada e é explicada, teste a teste, no relatório com referência ao tráfego do HAR. A lista de bloqueio personalizada (opcional, aba *Bloqueio*) cancela requisições a domínios escolhidos pelo usuário.
5. **Crawl headless do Blacklight x sessão real.** Ver seção 6.
6. **Instrumentação na página.** O código de medição roda no mesmo contexto dos scripts do site. Um site pode, em tese, detectá-lo ou contorná-lo. Os dados vindos da página são tratados como não confiáveis: são validados, truncados e limitados em quantidade.
7. **Atribuição por pilha de chamadas.** O script responsável é o primeiro quadro da pilha que não é do próprio plugin. Código que guardou uma referência antiga de uma API, ou que roda por `eval` sem URL, pode ser atribuído à própria página.
8. **Outras extensões.** Ver o item 1 do protocolo (seção 7).
9. **Requisições sem aba.** Requisições feitas por service workers ou pelo próprio navegador (`tabId = -1`) não são atribuídas a nenhuma página.
10. **Storage pré-existente.** Diferente dos cookies, o armazenamento HTML5 lido pelo content script não distingue o que foi gravado nesta visita do que já existia. Por isso o protocolo usa perfil novo, ou os dados do site apagados, antes de cada medição (seção 7, item 3).
11. **Limiares heurísticos.** Os limites de polling (5 requisições, mediana abaixo de 15 s, regularidade de 70%, duração de 30 s), de bounce no cliente (10 s) e de enumeração de fontes (20 famílias) são escolhas do projeto. Eles podem gerar falsos negativos (C2 lento e irregular) ou falsos positivos (heartbeats regulares de analytics, rotulados com severidade média).
12. **Pesos.** Os pesos são um julgamento normativo, justificado na seção 2. Outra ponderação levaria a outra nota. Por isso o relatório exibe sempre a quebra completa, e não só o número final.

---

## 9. Referências

- Englehardt, S.; Narayanan, A. *Online Tracking: A 1-million-site Measurement and Analysis*. ACM CCS, 2016.
- Englehardt, S.; Acar, G.; Narayanan, A. *No Boundaries: Exfiltration of personal data by session-replay scripts*. Freedom to Tinker, 2017.
- The Markup. *How We Built a Real-time Privacy Inspector*, 2020. https://themarkup.org/blacklight/2020/09/22/how-we-built-a-real-time-privacy-inspector
- The Markup. *blacklight-collector* (código-fonte). https://github.com/the-markup/blacklight-collector
- DuckDuckGo. *Privacy Test Pages*. https://github.com/duckduckgo/privacy-test-pages
- DuckDuckGo. *Tracker Radar*. https://github.com/duckduckgo/tracker-radar
- Public Suffix List. https://publicsuffix.org/list/
- IETF. RFC 6265, *HTTP State Management Mechanism*.
- MDN Web Docs. *WebExtensions*: `webRequest`, `cookies`, `content_scripts` (`world: "MAIN"`).
- Mozilla. *Total Cookie Protection* e *Enhanced Tracking Protection*.
