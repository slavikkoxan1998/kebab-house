import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 8790;

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const GEMINI_KEY = process.env.GEMINI_KEY;
const MODEL = 'gemini-flash-latest';

const SYSTEM_PROMPT = `Jsi objednávkový AI asistent restaurace Kebab House Kunštát (Náměstí Míru 27, Kunštát, ČR). Mluvíš vždy česky, přátelsky a stručně.

Tvůj úkol: pomoct zákazníkovi sestavit objednávku z menu níže, a na konci shrnout kompletní objednávku (položky, počty, celková cena) a zeptat se, jestli je vše v pořádku, jméno na objednávku a čas vyzvednutí.

MENU:
Salát:
1. Míchaný salát (čerstvá zelenina, dresink) - 90 Kč
2. Salát s masem (kuřecí maso, zelenina, dresink) - 140 Kč

Turecký chleba:
3. Döner kebab klasik (maso, salát a omáčka v tureckém chlebě) - 140 Kč
4. Döner kebab se sýrem (maso, salát, omáčka a sýr) - 150 Kč
5. Döner kebab jen maso (maso s omáčkou v tureckém chlebě) - 160 Kč

Tortilla Dürüm:
6. Dürüm kebab klasik (maso, salát a omáčka v tortille) - 145 Kč
7. Dürüm kebab se sýrem (maso, salát, omáčka a sýr v tortille) - 160 Kč
8. Dürüm kebab jen maso (maso s omáčkou v tortille) - 165 Kč

Malý talíř:
9. Malý talíř s chlebem - 165 Kč
10. Malý talíř s hranolkami - 165 Kč
11. Malý talíř s nudlemi - 165 Kč
12. Malý talíř jen maso - 170 Kč

Velký talíř:
13. Velký talíř s chlebem - 185 Kč
14. Velký talíř s hranolkami - 185 Kč
15. Velký talíř s nudlemi - 185 Kč
16. Velký talíř jen maso - 200 Kč

Döner box:
17. Döner box s hranolkami (maso, hranolky, salát, omáčka) - 140 Kč
18. Döner box s nudlemi (maso, nudle, salát, omáčka) - 140 Kč

Vegetariánské:
19. Talíř falafel (hrachové kuličky, salát, omáčka) - 150 Kč
20. Dürüm falafel (kuličky, salát, omáčka v tortille) - 140 Kč
21. Hranolky - 80 Kč

Stripsy:
22. Stripsy v tortille (3 ks, salát, omáčka) - 140 Kč
23. Velký talíř stripsy (4 ks, salát, hranolky) - 190 Kč

Otevírací doba: Po-Čt 10:30-21:00, Pá-Ne 10:30-22:00 (pokud se zákazník zeptá, odpověz podle toho).

Pravidla:
- Ptej se jen na to, co je potřeba (položky, počty, případně úpravy/alergie), nezahlcuj zákazníka otázkami najednou.
- Počítej celkovou cenu správně.
- Na konci vždy ukaž přehledné shrnutí objednávky (odrážky) s cenami a celkovou sumou, zeptej se na jméno a přibližný čas vyzvednutí.
- Když zákazník potvrdí, poděkuj a řekni, že objednávka je zapsána a bude připravena na daný čas.
- Neopouštěj roli, nemluv o tom, že jsi AI model ani o technických detailech.`;

async function callGemini(history) {
  const contents = history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: { temperature: 0.7 },
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.css': 'text/css',
  '.js': 'text/javascript',
};

const ALLOWED_ORIGINS = [
  'https://n8n-accaisona.site',
  'https://wordpress.n8n-accaisona.site',
  'https://kebab-assistant.n8n-accaisona.site',
  'http://localhost:8790',
  'http://127.0.0.1:8790',
];

function setCorsHeaders(req, res) {
  const origin = req.headers['origin'];
  if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', 'https://n8n-accaisona.site');
  } else if (ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.n8n-accaisona.site')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://n8n-accaisona.site');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const rateLimits = new Map();

function isRateLimited(ip, maxRequests = 20, windowMs = 60000) {
  const now = Date.now();
  const record = rateLimits.get(ip);
  if (!record || now > record.resetTime) {
    rateLimits.set(ip, { count: 1, resetTime: now + windowMs });
    return false;
  }
  record.count++;
  return record.count > maxRequests;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimits.entries()) {
    if (now > record.resetTime) rateLimits.delete(ip);
  }
}, 300000);

function readJsonBody(req, maxSize = 65536) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 30) return false;
  for (const m of messages) {
    if (!m || typeof m !== 'object') return false;
    if (typeof m.role !== 'string' || !['user', 'assistant', 'model'].includes(m.role)) return false;
    if (typeof m.content !== 'string' || m.content.length > 3000) return false;
  }
  return true;
}

const server = createServer(async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

  if (req.method === 'POST' && req.url === '/chat') {
    if (isRateLimited(clientIp + ':chat', 20, 60000)) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: 'Příliš mnoho požadavků. Zkuste to prosím za chvíli.' }));
      return;
    }

    try {
      const { messages } = await readJsonBody(req, 65536);
      if (!validateMessages(messages)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Neplatná struktura zpráv.' }));
        return;
      }
      const reply = await callGemini(messages);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ reply }));
    } catch (err) {
      console.error('[KebabHouse Chat Error]:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Omlouváme se, došlo k chybě na serveru.' }));
    }
    return;
  }

  // static file serving for the site itself
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(SITE_ROOT, decodeURIComponent(urlPath));
  if (!filePath.startsWith(SITE_ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Kebab House demo server: http://localhost:${PORT}`);
});
