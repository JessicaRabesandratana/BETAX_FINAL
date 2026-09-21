
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const fetchFn = globalThis.fetch;
const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ===============================
// CONFIGURATION GROQ
// ===============================

const GROQ_KEY =
  process.env.GROQ_API_KEY ||
  process.env.groq_api_key;

const DEFAULT_MODEL = 'openai/gpt-oss-20b';

// ===============================
// CHARGEMENT DES 3 FICHIERS JSON
// ===============================

function chargerJSON(nomFichier) {
  const chemin = path.join(
    __dirname,
    'data',
    nomFichier
  );

  try {
    const contenu = fs.readFileSync(
      chemin,
      'utf-8'
    );

    return JSON.parse(contenu);

  } catch (error) {
    console.error(
      `Erreur de chargement ${nomFichier}:`,
      error.message
    );

    return null;
  }
}

const busData = chargerJSON('bus.json');
const stopsData = chargerJSON('stops.json');
const metaData = chargerJSON('data-meta.json');

// ===============================
// VERIFICATION DES DONNEES
// ===============================

console.log('Bus JSON charge:', Boolean(busData));
console.log('Stops JSON charge:', Boolean(stopsData));
console.log('Meta JSON charge:', Boolean(metaData));

// ===============================
// FONCTIONS UTILITAIRES
// ===============================

function normaliser(texte) {
  return String(texte || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function convertirEnTexte(data) {
  if (data === null || data === undefined) {
    return '';
  }

  if (typeof data === 'string') {
    return data;
  }

  if (typeof data === 'number' || typeof data === 'boolean') {
    return String(data);
  }

  if (Array.isArray(data)) {
    return data
      .map(convertirEnTexte)
      .join(' ');
  }

  if (typeof data === 'object') {
    return Object.entries(data)
      .map(([cle, valeur]) => {
        return `${cle}: ${convertirEnTexte(valeur)}`;
      })
      .join(' ');
  }

  return '';
}

function transformerEnTableau(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (data && typeof data === 'object') {
    for (const cle of [
      'buses',
      'bus',
      'lines',
      'routes',
      'stops',
      'data',
      'features'
    ]) {
      if (Array.isArray(data[cle])) {
        return data[cle];
      }
    }
  }

  return [];
}

// ===============================
// RECHERCHE DANS LES 3 JSON
// ===============================

function rechercherDansDonnees(question) {
  const texteQuestion = normaliser(question);

  const mots = texteQuestion
    .split(/[^a-z0-9]+/)
    .filter((mot) => mot.length >= 3);

  function filtrerDonnees(data) {
    const tableau = transformerEnTableau(data);

    // Si le JSON n'est pas un tableau,
    // on le conserve comme contexte global.
    if (tableau.length === 0) {
      return data;
    }

    const resultats = tableau.filter((element) => {
      const texteElement = normaliser(
        convertirEnTexte(element)
      );

      return mots.some((mot) =>
        texteElement.includes(mot)
      );
    });

    return resultats.slice(0, 30);
  }

  return {
    bus: filtrerDonnees(busData),
    stops: filtrerDonnees(stopsData),
    meta: metaData
  };
}

// ===============================
// ROUTE HEALTH
// ===============================

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    status: 'healthy',
    groqConfigured: Boolean(
      GROQ_KEY &&
      GROQ_KEY.trim().startsWith('gsk_')
    ),
    modelUsed: DEFAULT_MODEL,
    busDataLoaded: Boolean(busData),
    stopsDataLoaded: Boolean(stopsData),
    metaDataLoaded: Boolean(metaData)
  });
});

// ===============================
// ROUTE ACCUEIL
// ===============================

app.get('/', (req, res) => {
  res.send(
    "Backend de l'application BetaX fonctionne !"
  );
});

// ===============================
// ROUTE CHATBOT
// ===============================

app.post('/chat', async (req, res) => {
  try {
    if (!GROQ_KEY) {
      return res.status(500).json({
        ok: false,
        reply:
          'Erreur : GROQ_API_KEY manquante sur Render.'
      });
    }

    if (!fetchFn) {
      return res.status(500).json({
        ok: false,
        reply:
          'Erreur : fetch non disponible sur ce serveur.'
      });
    }

    const body = req.body || {};

    let incomingMessages = body.messages;

    if (
      !incomingMessages &&
      typeof body.message === 'string'
    ) {
      incomingMessages = [
        {
          role: 'user',
          content: body.message
        }
      ];
    }

    if (
      !incomingMessages ||
      !Array.isArray(incomingMessages)
    ) {
      return res.status(400).json({
        ok: false,
        reply:
          'Erreur : tableau de messages invalide.'
      });
    }

    const messages = incomingMessages
      .map((msg) => {
        let role = String(
          msg.role || 'user'
        ).toLowerCase();

        if (
          role !== 'system' &&
          role !== 'assistant'
        ) {
          role = 'user';
        }

        return {
          role,
          content: String(
            msg.content || ''
          )
        };
      })
      .filter((msg) => msg.content.trim());

    const derniereQuestion =
      [...messages]
        .reverse()
        .find(
          (msg) => msg.role === 'user'
        )?.content || '';

    // ===============================
    // RECHERCHE DES DONNEES
    // ===============================

    const resultats =
      rechercherDansDonnees(
        derniereQuestion
      );

    // Limite la taille du contexte envoyé
    // pour éviter une requête trop volumineuse.
    const contexteBus = JSON.stringify(
      resultats
    ).slice(0, 120000);

    // ===============================
    // PROMPT DE L'IA
    // ===============================

    const systemMessage = {
      role: 'system',
      content: `
Tu es l'assistant officiel de BetaX.

Tu aides les utilisateurs à trouver
des informations sur les transports
en commun à Antananarivo.

Tu disposes de trois sources de données :
1. bus.json : lignes et informations sur les bus.
2. stops.json : informations sur les arrêts.
3. data-meta.json : métadonnées.

REGLES IMPORTANTES :

1. Utilise les données fournies pour répondre.
2. Ne fabrique jamais une ligne, un arrêt,
   un trajet ou une information.
3. Si les données ne permettent pas
   de répondre, dis-le clairement.
4. Réponds en français simple et naturel.
5. Donne les informations pertinentes
   sur les lignes et arrêts.
6. Si une information est absente,
   précise que tu ne l'as pas trouvée.
7. Ne prétends pas avoir accès à des données
   qui ne sont pas présentes dans le contexte.

DONNEES DE BETAX :

${contexteBus}
`
    };

    const payload = {
      model: DEFAULT_MODEL,
      messages: [
        systemMessage,
        ...messages
      ],
      max_tokens: 500,
      temperature: 0.5
    };

    // ===============================
    // APPEL API GROQ
    // ===============================

    const response = await fetchFn(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          'Authorization':
            `Bearer ${GROQ_KEY.trim()}`
        },

        body: JSON.stringify(payload)
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        reply:
          `Erreur Groq (${response.status}) : ` +
          `${data?.error?.message || 'Requête refusée'}`
      });
    }

    const replyText =
      data?.choices?.[0]?.message?.content || '';

    return res.json({
      ok: true,
      reply:
        replyText ||
        "L'IA a renvoyé un texte vide."
    });

  } catch (err) {
    console.error(
      'Erreur serveur :',
      err
    );

    return res.status(500).json({
      ok: false,
      reply:
        'Erreur proxy : ' + err.message
    });
  }
});

// ===============================
// DEMARRAGE DU SERVEUR
// ===============================

const port = process.env.PORT || 10000;

app.listen(
  port,
  '0.0.0.0',
  () => {
    console.log(
      `Serveur lancé sur le port ${port}`
    );
  }
);