# Presença · Tesla

Totem de presença para a recepção do Instituto Tecnológico Tesla. Interface em React, com a identidade azul e branca da escola, tipografia Chivo e teclado adaptado para tablets.

## Uso

- **Presença:** o aluno digita o CPF; se houver uma aula disponível da sua turma, a presença é registrada. Aulas simultâneas permitem escolher a turma.
- **Primeiro acesso:** o aluno procura seu cadastro e vincula o CPF. O vínculo não muda suas turmas. Se houver aula disponível, o fluxo segue para presença.
- **Coordenação:** acesso protegido para alunos, professores, turmas, frequência e exportação CSV.
- **Tablet:** em produção, a coordenação ativa cada aparelho por 30 dias. A lista de alunos não está disponível em aparelhos não autorizados.

## Desenvolvimento

Node.js 22.12 ou superior.

```sh
npm ci
cp .env.example .env
npm run build
npm start
```

Preencha `ADMIN_PIN_HASH` e `CPF_SALT` no `.env`. Gere o hash com `npm run hash:pin` e digite o código pelo terminal (a entrada fica oculta). Copie somente o hash para a variável privada `ADMIN_PIN_HASH` na hospedagem e remova a variável antiga `ADMIN_PIN`. Os arquivos reais da escola ficam em `dados/` e não são versionados. Uma instalação sem dados inicia vazia. Para trabalhar somente na interface, execute `npm run dev:ui` com o servidor em execução.

```sh
npm run check
npm test
npm audit
```

Os testes usam arquivos temporários e alunos fictícios, sem acessar a base da escola.

## Hospedagem

O projeto está preparado para a Vercel: o Express é exportado como uma função e o Vite publica a interface em `public/`. `vercel.json` inclui a migração SQL usada na inicialização do banco. Importe o repositório `Mariastodi/Tesla` no projeto Vercel e mantenha a raiz do projeto no diretório do repositório. O build é `npm run build`.

Configure estas variáveis em **Project → Settings → Environment Variables** para Production (e Preview, se for usar previews):

- `DATABASE_URL`: URI **Transaction pooler** do Supabase (porta `6543`). O servidor aplica TLS no `pg.Pool`; a variável fica privada no Vercel para Production (e Preview, se necessário). Nunca use o prefixo `VITE_` nem exponha essa URI no navegador.
- `ADMIN_PIN_HASH`: hash scrypt de um código de 8 a 128 caracteres.
- `CPF_SALT`: segredo de pelo menos 32 caracteres. Preserve o valor atual para continuar reconhecendo os CPFs já vinculados.
- `DEVICE_SECRET`: segredo aleatório longo para assinar a ativação dos tablets.
- `TRUST_PROXY_HOPS`: `1`.
- `GOOGLE_APPS_SCRIPT_URL` e `GOOGLE_APPS_SCRIPT_TOKEN`: opcionais, para a integração com a planilha.

Não configure `ADMIN_PIN` quando usar `ADMIN_PIN_HASH`. A Vercel executa o Express sob demanda e não mantém o processo vivo; por isso a sincronização periódica de 60 segundos não roda lá. A sincronização continua disponível pelo botão **Tentar sincronizar** no painel. A sincronização automática periódica requer um agendador externo ou um plano/configuração de cron compatível com a frequência necessária.

Depois de configurar as variáveis, faça o primeiro deploy e confira `/health`. Antes de apontar o tablet para o novo endereço, valide o fluxo de presença e a conexão com o banco. O serviço no Render e o arquivo `render.yaml` podem ser mantidos durante a migração como opção de retorno.

A produção recusa inicializar sem banco e segredos adequados. As funções Vercel rodam em `gru1` (São Paulo), perto do projeto Supabase em `sa-east-1`. A conexão do navegador é sempre same-origin via `/api/*`; somente a função serverless lê `DATABASE_URL` usando `pg`. As migrações criam o esquema e habilitam RLS sem políticas públicas. Guarde `CPF_SALT` com o backup: trocar esse segredo impede reconhecer os CPFs já vinculados. A importação inicial só aceita uma base vazia e exige autenticação da coordenação. Dados pessoais nunca devem ser enviados ao GitHub.

O plano gratuito do Render pode suspender o serviço após inatividade e demorar a responder na primeira abertura. Manter o tablet aberto facilita verificar a conexão, mas uma hospedagem gratuita não oferece garantia de disponibilidade contínua.

## Segurança e limites

- Código da coordenação protegido por scrypt com salt aleatório, verificado apenas no servidor. O hash tem prioridade sobre a variável legada `ADMIN_PIN`; o valor legado continua aceito para permitir migração. Use HTTPS em produção.
- CPF armazenado como HMAC-SHA256; o número puro não é persistido.
- Respostas do totem limitadas aos campos necessários, sem telefone ou hash.
- Operações isoladas e gravação atômica; PostgreSQL usa transação e bloqueio entre instâncias.
- Uma presença por aluno e sessão; vínculos concorrentes de CPF são rejeitados.
- Helmet/CSP, rejeição de requisições de outros sites, limite de tentativas e respostas sem cache.
- Fuso horário fixo de Fortaleza, independente do servidor.
- CPF e sessão administrativa limpos após inatividade.

O primeiro acesso é uma autodeclaração num tablet autorizado. A validação matemática do CPF não comprova a identidade da pessoa. A recepção deve orientar o aluno e conferir cadastros ambíguos; não se trata de autenticação biométrica ou de consulta à Receita Federal.

## Estrutura

- `client/src/main.jsx`: totem e primeiro acesso.
- `client/src/Admin.jsx`: painel acadêmico carregado sob demanda.
- `client/src/api.js`: comunicação com a API.
- `server.js`: API, persistência e proteção de acesso.
- `tests/`: integração com dados fictícios.
- `scripts/`: ferramentas de operação.

Nenhuma marca ou etiqueta de ferramenta de desenvolvimento aparece na interface.

## Ponto dos professores

No totem, toque **Professor**, digite o CPF e confirme. Cadastre o CPF de cada professor em **Coordenação → Professores → Editar** antes do primeiro uso. O servidor determina a aula e registra entrada ou saída; em horários ambíguos, solicita a escolha da aula. Aulas em dois períodos têm registros independentes. A grade da turma aceita vários dias e horários.

Por padrão, a entrada abre 30 minutos antes, a saída abre 60 minutos antes do fim e fecha 60 minutos depois. Repetições dentro de 5 minutos não viram saída. A coordenação pode ajustar esses valores em **Ponto dos professores**. O identificador de cada tentativa impede duplicar registros ao repetir uma requisição após falha de rede. Não existe saída sem entrada; após a janela permitida, procure a coordenação.

Agende substituições por data e aula no painel de ponto. O titular permanece na grade; o registro guarda separadamente quem estava previsto e quem compareceu. Uma aula com ponto não permite alterar sua substituição. Registros feitos preservam nomes e horários da ocasião.

A confirmação ocupa a tela em verde e retorna automaticamente ao início (padrão: 5,5 segundos). O teclado se adapta ao tablet em pé ou deitado. O fluxo dos alunos continua separado.

### Persistência, relatórios e migração

A migração `server/migrations/001_teacher_workflow.sql` roda automaticamente ao iniciar com PostgreSQL. Ela acrescenta a tabela de ponto, substituições e estado da sincronização sem apagar alunos, turmas ou presenças. Faça backup antes de atualizar a produção. Gravações são transacionais e serializadas entre instâncias; falha na planilha não desfaz o ponto.

**Baixar Excel** gera seis abas com datas/horários numéricos, filtros, cabeçalhos fixos e durações. O intervalo máximo é 93 dias. Horas realizadas exigem entrada e saída. “Sem registro” indica ausência de ponto, não falta confirmada. Não há cálculo salarial. Aulas sem ponto usam a grade atual e só aparecem a partir da ativação do recurso; o sistema não inventa faltas históricas.

### Google Planilhas

Planilha preparada: https://docs.google.com/spreadsheets/d/18dbQrczPuRkr3CG5mTHduJ159YJFGFMv_QLAcuAraf4/edit

Para ativar a integração na Vercel:

1. Vincule um projeto do Apps Script à planilha e implemente-o como app da Web. A função `doPost` aceita `source`, `generatedAt`, `tables` e um token secreto, e grava cada tabela na aba correspondente.
2. Salve `SYNC_TOKEN` nas propriedades do script e configure `GOOGLE_APPS_SCRIPT_URL` e o mesmo valor em `GOOGLE_APPS_SCRIPT_TOKEN` nas variáveis de ambiente da Vercel. Não coloque a URL nem o token no repositório.
3. Use **Tentar sincronizar** no painel de ponto. Confira o horário da última sincronização e os dados nas abas REGISTROS/RESUMO.

Sem essa URL, o painel informa que a integração não está configurada; o ponto e a exportação Excel continuam funcionando.

No Render, o servidor sincroniza periodicamente (60 segundos por padrão). Na Vercel, use **Tentar sincronizar** para iniciar a sincronização; falhas ficam persistidas para uma tentativa posterior. A planilha online conserva todos os pontos registrados; o resumo cobre o mês atual até hoje. Somente as seis abas gerenciadas são reescritas: crie outra aba para anotações. CPFs e seus hashes nunca são exportados. O banco é a fonte dos dados; alterações manuais nas abas gerenciadas serão substituídas.
