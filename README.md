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

O arquivo `render.yaml` configura um serviço Node no plano gratuito. Use PostgreSQL externo persistente; não use arquivos locais para armazenar presença no Render. Configure `DATABASE_URL`, `ADMIN_PIN_HASH` (hash scrypt de um código de 8 a 128 caracteres), `CPF_SALT` (32+ caracteres), `DEVICE_SECRET` e `TRUST_PROXY_HOPS=1`.

A produção recusa inicializar sem banco e segredos adequados. Guarde `CPF_SALT` com o backup: trocar esse segredo impede reconhecer os CPFs já vinculados. A importação inicial só aceita uma base vazia e exige autenticação da coordenação. Dados pessoais nunca devem ser enviados ao GitHub.

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
