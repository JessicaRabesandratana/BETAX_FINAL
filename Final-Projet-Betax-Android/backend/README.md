## Render deployment

This proxy is ready for Render. Create a Web Service with `backend` as the
root directory, or use the repository `render.yaml` blueprint.

- Build command: `npm install`
- Start command: `npm start`
- Health check: `/health`
- Required environment variable: `GROQ_API_KEY`

After deployment, open the generated `/health` URL. It must return
`ok: true` and `groqConfigured: true`.
Betax Chat Proxy

Node.js proxy to securely call Groq's Chat Completions API (free, fast LLM).

Setup

1. Get a free API key at https://console.groq.com/keys
2. Copy `.env.example` to `.env` and set `GROQ_API_KEY`.
3. Install dependencies:

```bash
npm install
```

4. Start the server:

```bash
npm start
```

Endpoint

POST /chat
Body: { messages: [{role:'user'|'system'|'assistant', content:'...'}], model?: string (default: mixtral-8x7b-32768), max_tokens?: number }

The proxy forwards the request to Groq API and returns the response JSON.

Free Models Available
- mixtral-8x7b-32768 (default, fast & good quality)
- llama-3.1-70b-versatile
- gemma-7b-it
