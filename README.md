<h1 align="center">
  <img src="apps/web/src/assets/floway-blue.svg" alt="Floway logo" width="120" height="120"><br>
  Floway
</h1>

Floway is a self-hosted LLM API gateway for coding agents and API clients, with
a web dashboard. It connects GitHub Copilot, ChatGPT, Claude.ai, Azure AI,
custom HTTP providers, and Ollama through OpenAI, Anthropic, and
Gemini-compatible APIs.

## Deployment

### Cloudflare Workers

Ask your agent or follow the
[$deploy-to-cloudflare](.agents/skills/deploy-to-cloudflare/SKILL.md) skill yourself
to configure and deploy Floway to your Cloudflare account.

### Docker

```bash
git clone https://github.com/Menci/Floway.git
cd Floway
ADMIN_KEY='replace-with-a-secret' docker compose -f docker/docker-compose.yml up --build -d
```

Open <http://localhost:8788>, leave the username blank, and log in with
`ADMIN_KEY`. Data persists in the `floway-data` volume.

### Podman/systemd

Ask your agent or follow the [deployment guide](docker/systemd/README.md) yourself
to run Floway as a systemd service with Podman.

## Usage

Add an upstream under **Providers → Upstreams**, then create a key under
**Services → API Keys**. Use the API key in your client code or configure your
agents to use Floway as provider through **Agent Setup**.

GitHub Copilot decision models expose `POST /v1/systemone`. Supply a model,
`state`, and typed `questions`; the response contains numerical answers and
probabilities. See the [Microsoft-Decision-1 guide](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision)
for the `choice`, `noul`, and `score` request shapes.

Copilot's `gpt-6-luna-decisions` uses `POST /v1/decisions` instead. Send
`input` and an array of `predicate`, `choice`, or `score` questions; see the
[OpenAI Decisions API](https://developers.openai.com/api/reference/resources/decisions/methods/create)
for the request and response shapes. The two decision protocols are not interchangeable.

## Development

```bash
pnpm install
pnpm run dev:node
```

## License

MIT
