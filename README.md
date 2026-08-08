# Secure Custom AI Chat

A self-hosted, server-side proxied AI chat interface with a public landing page and a full-featured chat app. Supports OpenAI, Anthropic, Groq, Ollama, and 12+ compatible providers.

**Developed by [Suresh Kumar Mahato (ssblucky7)](https://github.com/ssblucky7)**

---

## Pages

| Route | Description |
|---|---|
| `/` | Landing home page |
| `/app` | Chat application |
| `/features` | Feature overview |
| `/providers` | Supported providers |
| `/security` | Security details |
| `/docs` | Setup & deployment guide |
| `/faq` | Frequently asked questions |
| `/about` | About the project |
| `/changelog` | Release history |
| `/privacy` | Privacy policy |
| `/terms` | Terms of service |

---

## Features

- Server-side API key protection — keys never reach the browser
- OpenAI-compatible and Anthropic-compatible streaming chat (SSE)
- Stop and regenerate controls
- Copy full messages and individual code snippets
- Persistent browser chat history and saved provider configuration
- Mobile sidebar, dynamic viewport and safe-area support
- Accessible dialogs, focus styles, live status regions and keyboard controls
- Chat export to Markdown
- Rate limiting, CSP and security headers
- SEO landing page with structured data, Open Graph, and sitemap
- Installable PWA with offline support
- SSRF protection with DNS-level validation
- 12+ provider presets (OpenAI, Anthropic, Groq, OpenRouter, Together AI, DeepSeek, Mistral, Ollama, LM Studio, ZenMux)

---

## Requirements

- Node.js 18 or newer
- npm 8 or newer
- An API key from at least one AI provider, or a local Ollama installation

---

## Quick Start

```bash
# 1. Clone the project
git clone https://github.com/ssblucky7/secure-custom-ai-chat.git
cd secure-custom-ai-chat

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env and add your provider values

# 4. Start the server
npm start
# Open http://localhost:3000
```

### Minimal `.env` example (OpenAI)

```env
AI_API_URL=https://api.openai.com/v1
AI_API_KEY=sk-proj-...
AI_DEFAULT_MODEL=gpt-4o-mini
```

### Anthropic

```env
AI_API_URL=https://api.anthropic.com
AI_API_KEY=sk-ant-...
AI_DEFAULT_MODEL=claude-sonnet-4-5
AI_API_TYPE=anthropic
```

### Ollama (local)

```env
AI_API_URL=http://localhost:11434/v1
AI_API_KEY=ollama
AI_DEFAULT_MODEL=llama3
ALLOW_PRIVATE_PROVIDER_URLS=1
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | TCP port |
| `NODE_ENV` | `development` | Set `production` for prod |
| `AI_API_URL` | — | Provider base URL |
| `AI_API_KEY` | — | Server-side API key (never sent to browser) |
| `AI_DEFAULT_MODEL` | — | Default model ID |
| `AI_ALLOWED_MODELS` | — | Comma-separated allowed model IDs |
| `AI_MAX_TOKENS_LIMIT` | `8192` | Max tokens per request |
| `ALLOW_USER_PROVIDERS` | `0` | Set `1` to let users supply their own key |
| `ALLOW_PRIVATE_PROVIDER_URLS` | `0` | Set `1` for Ollama local dev only |
| `TRUST_PROXY` | `0` | Set `1` behind nginx/Caddy |

---

## Production Deployment

- Keep `.env` private and never commit it.
- Use HTTPS in production.
- Set `TRUST_PROXY=1` when behind a trusted reverse proxy (nginx, Caddy).
- Replace `yourdomain.com` in all HTML canonical/OG tags with your real domain.
- Use provider-side spending limits and key rotation.
- Add authentication before exposing the chat publicly.

### nginx example

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;
    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 120s;
    }
}
```

### PM2

```bash
npm install -g pm2
pm2 start server.js --name "ai-chat" --env production
pm2 save && pm2 startup
```

---

## User-Provided Providers

With `ALLOW_USER_PROVIDERS=1`, each user can enter their own provider URL, API key, and model in the Chat settings dialog. Settings are stored in `localStorage`. Public provider URLs must use HTTPS. Private/localhost URLs are blocked by default — set `ALLOW_PRIVATE_PROVIDER_URLS=1` only for trusted local development.

---

## Fixing Placeholder API Key Errors

If the provider reports `Incorrect API key provided: replace_...`, an example key from an older setup is saved in the browser. Open **AI Configure / Setup**, click **Clear saved setup**, then enter your real API key.

---

## License

MIT — free to use, modify, and self-host.

---

*Developed by **Suresh Kumar Mahato** ([@ssblucky7](https://github.com/ssblucky7))*
