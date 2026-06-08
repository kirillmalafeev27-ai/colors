/* Сервер приложения "Учимся читать по-немецки".
 *  - отдаёт страницу index.html (ищет её в нескольких местах — устойчиво к
 *    тому, лежит ли она в public/ или рядом с server.js)
 *  - проксирует ElevenLabs (ключ только на сервере, в браузер не попадает)
 *  - кэширует аудио на диске
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.PORT || 3000;

const API_KEY  = process.env.ELEVENLABS_API_KEY || '';
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5';
const LANG     = process.env.ELEVENLABS_LANG || 'de';

// Ищем index.html в нескольких возможных местах
const INDEX_CANDIDATES = [
  path.join(__dirname, 'public', 'index.html'),
  path.join(__dirname, 'index.html'),
  path.join(process.cwd(), 'public', 'index.html'),
  path.join(process.cwd(), 'index.html')
];
function findIndex() {
  for (const p of INDEX_CANDIDATES) { if (fs.existsSync(p)) return p; }
  return null;
}

const CACHE_DIR = path.join(process.env.TMPDIR || '/tmp', 'tts-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

// статика (если рядом со страницей есть другие файлы); саму index.html
// отдаём ниже через catch-all с запретом кэша, чтобы правки доезжали сразу
const found = findIndex();
if (found) app.use(express.static(path.dirname(found), { index: false, maxAge: '1h' }));

app.get('/api/config', (req, res) => {
  res.json({ voiceId: VOICE_ID, modelId: MODEL_ID, lang: LANG, hasKey: !!API_KEY });
});

app.post('/api/tts', async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || '').slice(0, 500);
    if (!text.trim()) return res.status(400).json({ error: 'empty_text' });
    if (!API_KEY) {
      return res.status(500).json({
        error: 'no_api_key',
        detail: 'Не задана переменная окружения ELEVENLABS_API_KEY на сервере.'
      });
    }

    const voiceId = String((req.body && req.body.voiceId) || VOICE_ID);
    const modelId = String((req.body && req.body.modelId) || MODEL_ID);

    const hashKey = crypto.createHash('sha1')
      .update([voiceId, modelId, LANG, text].join('|')).digest('hex');
    const file = path.join(CACHE_DIR, hashKey + '.mp3');

    if (fs.existsSync(file)) {
      res.set('Content-Type', 'audio/mpeg');
      res.set('X-Cache', 'HIT');
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      return fs.createReadStream(file).pipe(res);
    }

    const body = {
      text, model_id: modelId,
      voice_settings: { stability: 0.5, similarity_boost: 0.8 }
    };
    if (LANG) body.language_code = LANG;

    const r = await fetch(
      'https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voiceId),
      { method: 'POST',
        headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
        body: JSON.stringify(body) }
    );

    if (!r.ok) {
      const detail = (await r.text()).slice(0, 500);
      return res.status(r.status).json({ error: 'elevenlabs_error', detail });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFile(file, buf, () => {});
    res.set('Content-Type', 'audio/mpeg');
    res.set('X-Cache', 'MISS');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: 'server_error', detail: String(e).slice(0, 300) });
  }
});

// Любой GET-запрос (кроме /api) отдаёт страницу — поэтому "/" всегда работает
app.get(/^(?!\/api).*/, (req, res) => {
  const idx = findIndex();
  if (idx) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(idx);
  }
  res.status(500).send(
    '<h2>index.html не найден на сервере.</h2>' +
    '<p>Проверьте, что в репозитории есть файл <code>public/index.html</code> ' +
    '(или <code>index.html</code> рядом с <code>server.js</code>).</p>'
  );
});

app.listen(PORT, () => {
  const idx = findIndex();
  console.log('Сервер запущен на порту ' + PORT);
  console.log(idx ? ('index.html найден: ' + idx) : 'ВНИМАНИЕ: index.html НЕ найден!');
});
