require('dotenv').config();
const express = require('express');
const cors = require('cors');

const fetchFn = globalThis.fetch;

const app = express();
app.use(cors());
app.use(express.json());

const GROQ_KEY = process.env.GROQ_API_KEY;
// Modèle Groq valide
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'healthy', groqConfigured: Boolean(GROQ_KEY) });
});

app.post('/chat', async (req, res) => {
  try {
    if (!GROQ_KEY) {
      return res.status(500).json({ error: 'GROQ_API_KEY is missing. Set it in backend/.env' });
    }

    const body = req.body || {};
    const incomingMessages = body.messages ?? (typeof body.message === 'string' ? [{ role: 'user', content: body.message }] : null);
    const model = body.model || DEFAULT_MODEL;
    const maxTokens = Number(body.max_tokens) || 500;

    if (!incomingMessages || !Array.isArray(incomingMessages)) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const messages = incomingMessages.map((msg, index) => {
      const role = msg.role || 'user';
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
      return { role, content };
    });

    const payload = {
      model: model.includes('llama') ? model : DEFAULT_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: Number(body.temperature) || 0.5
    };

    const response = await fetchFn('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_KEY}`
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

    const reply = data?.choices?.[0]?.message?.content || '';

    return res.json({
      ok: true,
      reply,
      model,
      response: data
    });
  } catch (err) {
    console.error('Groq proxy error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Betax chat proxy listening on ${port}`));
