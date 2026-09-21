require('dotenv').config();
const express = require('express');
const cors = require('cors');

const fetchFn = globalThis.fetch;
const app = express();

app.use(cors());
app.use(express.json());

// Force la lecture depuis les variables d'environnement système (Render) ou locale (.env)
const GROQ_KEY = process.env.GROQ_API_KEY || process.env.groq_api_key;
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    status: 'healthy',
    groqConfigured: Boolean(GROQ_KEY && GROQ_KEY.trim().startsWith('gsk_')),
    envDetected: Object.keys(process.env).filter(k => k.toLowerCase().includes('groq'))
  });
});

app.post('/chat', async (req, res) => {
  try {
    if (!GROQ_KEY) {
      return res.status(500).json({ error: 'GROQ_API_KEY is missing. Set it in Render Dashboard Environment.' });
    }

    const body = req.body || {};
    const incomingMessages = body.messages ?? (typeof body.message === 'string' ? [{ role: 'user', content: body.message }] : null);
    const model = body.model || DEFAULT_MODEL;
    const maxTokens = Number(body.max_tokens) || 500;

    if (!incomingMessages || !Array.isArray(incomingMessages)) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const messages = incomingMessages.map((msg) => {
      return { role: msg.role || 'user', content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '') };
    });

    const payload = {
      model: DEFAULT_MODEL, // Toujours forcer un modèle Groq officiel et valide
      messages,
      max_tokens: maxTokens,
      temperature: Number(body.temperature) || 0.5
    };

    const response = await fetchFn('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY.trim()}`
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || 'Groq API request failed',
        details: data
      });
    }

    return res.json({
      ok: true,
      reply: data?.choices?.[0]?.message?.content || '',
      model
    });
  } catch (err) {
    console.error('Groq proxy error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Betax chat proxy listening on ${port}`));
