/* Маленький сервер для приложения "Учимся читать по-немецки".
 *
 * Что он делает:
 *  - отдаёт статическую страницу из папки public
 *  - проксирует запросы к ElevenLabs (ключ хранится ТОЛЬКО на сервере,
 *    в браузер он никогда не попадает)
 *  - кэширует сгенерированное аудио на диске, чтобы один и тот же звук
 *    не запрашивался у ElevenLabs повторно
 *
 * Нужен только один секрет — переменная окружения ELEVENLABS_API_KEY.
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.PORT || 3000;

// --- настройки (можно переопределить переменными окружения на Render) ---
const API_KEY  = process.env.ELEVENLABS_API_KEY || '';
// Голос по умолчанию из документации ElevenLabs. Свой ID можно взять в кабинете
// ElevenLabs (Voices -> у голоса есть Voice ID) и положить в ELEVENLABS_VOICE_ID.
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
// flash v2.5 — быстрый, дешёвый и поддерживает явное указание языка.
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5';
const LANG     = process.env.ELEVENLABS_LANG || 'de';

// Папка кэша. На бесплатном тарифе Render диск временный (очищается при
// перезапуске) — это нормально: в браузере есть свой постоянный кэш.
const CACHE_DIR = path.join(process.env.TMPDIR || '/tmp', 'tts-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Безопасные (не секретные) настройки для фронтенда
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
      .update([voiceId, modelId, LANG, text].join('|'))
      .digest('hex');
    const file = path.join(CACHE_DIR, hashKey + '.mp3');

    // 1) отдаём из дискового кэша, если есть
    if (fs.existsSync(file)) {
      res.set('Content-Type', 'audio/mpeg');
      res.set('X-Cache', 'HIT');
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      return fs.createReadStream(file).pipe(res);
    }

    // 2) иначе генерируем у ElevenLabs
    const body = {
      text,
      model_id: modelId,
      voice_settings: { stability: 0.5, similarity_boost: 0.8 }
    };
    if (LANG) body.language_code = LANG;

    const r = await fetch(
      'https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voiceId),
      {
        method: 'POST',
        headers: {
          'xi-api-key': API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify(body)
      }
    );

    if (!r.ok) {
      const detail = (await r.text()).slice(0, 500);
      return res.status(r.status).json({ error: 'elevenlabs_error', detail });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFile(file, buf, () => {}); // пишем в кэш, ошибки игнорируем

    res.set('Content-Type', 'audio/mpeg');
    res.set('X-Cache', 'MISS');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: 'server_error', detail: String(e).slice(0, 300) });
  }
});

app.listen(PORT, () => console.log('Сервер запущен на порту ' + PORT));
