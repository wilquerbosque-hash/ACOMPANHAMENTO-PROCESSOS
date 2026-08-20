ACOMPANHAMENTO-PROCESSOS
Sistema interno da Konsi para acompanhar processos judiciais que questionam
operações de crédito (consignado, CLT etc.) contra os bancos parceiros. A
Konsi não é parte nesses processos — quem litiga é o escritório
contratado pelo banco. O sistema existe para antecipar risco de eventual
imputação de débito à Konsi, provisionar contabilmente e reunir base para
impugnação de débitos.
Arquitetura
```
Navegador → index.html (HTML+CSS+JS puro, sem framework, sem build)
    ↓
GitHub Pages → publica o front-end automaticamente a cada commit em `main`
    ↓
Supabase → Postgres (banco) + Auth (login) + Edge Functions (Deno/TypeScript)
    ↓
APIs externas → DataJud (CNJ, oficial) e DJEN (não-oficial, mas pública)
    ↓
Slack → notificações via Incoming Webhook
```
Edge Functions (`supabase/functions/`)
`sync-datajud` — sincroniza movimentações processuais via API pública
do CNJ. Roda ao login (com throttle de 4h) e também em "modo processo
único" logo após um cadastro manual. Preenche metadados estruturados da
capa processual (classe, órgão julgador, valor da causa etc.).
`sync-djen` — sincroniza comunicações do Diário de Justiça Eletrônico
Nacional. Independente da `sync-datajud` de propósito (endpoint não
oficial, pode quebrar sem aviso do CNJ).
`admin-usuarios` — CRUD de usuários, restrito a um único e-mail
(`SUPER_ADMIN_EMAIL`), independente do `is_admin` genérico.
Por que duas funções fazem coisas parecidas (e isso é proposital)
`sync-datajud` e `sync-djen` ambas podem preencher `classe_processual` e
`orgao_julgador` — mas cada uma só escreve se o campo ainda estiver vazio
(nunca uma sobrescreve a outra). Isso não é duplicação por descuido: a API
do DataJud, sendo a fonte estruturada "canônica", às vezes não retorna esse
dado ou retorna incompleto para um tribunal específico; o DJEN, consultando
as comunicações publicadas, frequentemente já tem essa informação. As
colunas `classe_processual_fonte` / `orgao_julgador_fonte` (migração 34)
registram qual dos dois robôs efetivamente preencheu cada campo, para dar
para auditar isso depois.
Detecção de resultado (sentença/acórdão) por palavra-chave só existe na
`sync-djen`, nunca na `sync-datajud` — e isso não é escolha de design, é
limitação da própria API: o DataJud devolve só metadados estruturados
(classe, movimentações por código), nunca o texto da decisão em si. Só o
DJEN traz o recorte informativo do CNJ com o texto integral da intimação —
é o único lugar onde dá para procurar palavras como "procedente",
"improvido" etc. A sugestão de resultado nunca é aplicada automaticamente:
sempre exige confirmação humana na tela do processo.
Banco de dados
Migrações SQL numeradas (`01_...sql`, `02_...sql`, ...) — ficam neste
repositório só como histórico. Elas nunca aplicam sozinhas: precisam ser
rodadas manualmente no SQL Editor do Supabase, na ordem, sempre que uma
mudança de schema for necessária.
Como aplicar mudanças
Mudança de banco → arquivo `.sql` numerado, rodado manualmente no SQL
Editor do Supabase.
Mudança de front-end → substituir o `index.html` inteiro no GitHub
(conferir sempre se o arquivo colado termina em `</html>`).
Edge Function nova ou alterada → precisa estar em
`supabase/functions/<nome>/index.ts` e declarada em
`supabase/config.toml` (`[functions.nome-da-funcao]`), senão a integração
do GitHub não publica sozinha.
Experiência mobile é requisito permanente em qualquer tela nova (o
sistema é PWA, instalável no celular).
