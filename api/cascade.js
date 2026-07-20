const https = require('https');

const SB_URL = process.env.SUPABASE_URL || 'https://alazsyhlydhimfqpdros.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function sbFetch(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(SB_URL + path);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: opts.method || 'GET',
      headers: {
        'apikey': SB_KEY,
        'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json',
        'Prefer': opts.prefer || 'return=representation',
        ...opts.headers,
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

function claudeFetch(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Claude parse error')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildPrompt(name) {
  return `Du bist ein medizinischer Biochemie-Experte. Erstelle für den Biomarker "${name}" zwei biochemische Kaskaden im exakten JSON-Format unten.

Regeln:
- "steps": genau 6 Einträge, jeder max 25 Zeichen. Nutze \\n für Zeilenumbruch (Hauptbegriff\\nErlärung)
- "desc": 1–2 Sätze, klinisch präzise, auf Deutsch
- "color": passende Hex-Farbe für den Biomarker
- "aufnahme": Weg vom Nahrungsmittel/Vorläufer zur aktiven Form im Körper
- "wirkung": biochemischer Wirkmechanismus / Signalweg

Antworte NUR mit validem JSON, kein Markdown, keine Erklärung:

{
  "aufnahme": {
    "desc": "...",
    "steps": ["Schritt1\\nUntertitel","Schritt2\\nUntertitel","Schritt3\\nUntertitel","Schritt4\\nUntertitel","Schritt5\\nUntertitel","Schritt6\\nUntertitel"],
    "color": "#hexcode"
  },
  "wirkung": {
    "desc": "...",
    "steps": ["Schritt1\\nUntertitel","Schritt2\\nUntertitel","Schritt3\\nUntertitel","Schritt4\\nUntertitel","Schritt5\\nUntertitel","Schritt6\\nUntertitel"],
    "color": "#hexcode"
  }
}`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const name = (req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });

  try {
    // 1. Supabase-Cache prüfen
    const cached = await sbFetch(
      `/rest/v1/biomarker_cascades?name=eq.${encodeURIComponent(name)}&select=cascade_data&limit=1`
    );
    if (cached.status === 200 && Array.isArray(cached.body) && cached.body.length > 0) {
      return res.status(200).json({ source: 'cache', cascade: cached.body[0].cascade_data });
    }

    // 2. Claude generiert neue Kaskade
    if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'No API key' });
    const aiRes = await claudeFetch(buildPrompt(name));
    const text = aiRes?.content?.[0]?.text || '';
    const cascade = JSON.parse(text);

    // 3. In Supabase speichern
    await sbFetch('/rest/v1/biomarker_cascades', {
      method: 'POST',
      prefer: 'return=minimal',
      body: { name, cascade_data: cascade, generated_at: new Date().toISOString() },
    });

    return res.status(200).json({ source: 'ai', cascade });
  } catch (err) {
    console.error('cascade error:', err);
    return res.status(500).json({ error: err.message });
  }
};
