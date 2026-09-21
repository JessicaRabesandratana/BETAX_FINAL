require('dotenv').config();
const express = require('express');
const cors = require('cors');

const fetchFn = globalThis.fetch;
const app = express();

app.use(cors());
app.use(express.json());

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
      return res.status(500).json({ ok: false, reply: 'Erreur: GROQ_API_KEY manquante sur Render.' });
    }

    const body = req.body || {};
    let incomingMessages = body.messages;

    if (!incomingMessages && typeof body.message === 'string') {
      incomingMessages = [{ role: 'user', content: body.message }];
    }

    if (!incomingMessages || !Array.isArray(incomingMessages)) {
      return res.status(400).json({ ok: false, reply: 'Erreur: tableau de messages invalide.' });
    }

    const messages = incomingMessages.map((msg) => {
      let role = String(msg.role || 'user').toLowerCase();
      if (role !== 'system' && role !== 'assistant') role = 'user';
      return { role, content: String(msg.content || '') };
    });

    const payload = {
      model: DEFAULT_MODEL,
      messages: messages,
      max_tokens: 500,
      temperature: 0.5
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
        ok: false,
        reply: `Erreur Groq (${response.status}): ${data?.error?.message || 'Requete refusee'}`
      });
    }

    const replyText = data?.choices?.[0]?.message?.content || '';

    return res.json({
      ok: true,
      reply: replyText || "L'IA a renvoyé un texte vide."
    });
  } catch (err) {
    return res.status(500).json({ ok: false, reply: 'Erreur proxy: ' + err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Proxy listening on ${port}`));
