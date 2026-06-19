// backend/server.js
const express    = require('express');
const bodyParser = require('body-parser');
const { Pool }   = require('pg');
const axios      = require('axios');
const app        = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const WORKER_BASE_URL = process.env.WORKER_BASE_URL || 'http://localhost:4000';

// ─────────────────────────────────────────────
// Valid voices — must stay in sync with
// voiceMap keys in audio-robot.js
// ─────────────────────────────────────────────
const validVoices = [
  // Female
  'Luna', 'Aria', 'Zoe', 'Calla', 'Erin',
  'Kore', 'Lucy', 'Leda', 'Sally', 'Violet',
  // Male
  'Rex', 'Dave', 'Marcus', 'Desmond', 'Puck', 'Finn',
];

const APPROVAL_REQUIRED_USER = 6646033752;
const validContentFlows      = ['news', 'listicle'];
const validMediaTypes        = ['images', 'videos', 'mixed'];
const validMediaModes        = ['auto', 'manual'];
const validVideoTypes        = ['reels', 'shorts', 'longform'];

const validCaptionStyles = [
  'Karaoke', 'Banger', 'Acid', 'Lovly', 'Marvel', 'Marker',
  'Neon Pulse', 'Beasty', 'Crazy', 'Safari', 'Popline', 'Desert',
  'Hook', 'Sky', 'Flamingo', 'Deep Diver B&W', 'New', 'Catchy',
  'From', 'Classic', 'Classic Big', 'Old Money', 'Cinema',
  'Midnight Serif', 'Aurora Ink'
];

app.use(bodyParser.json());

// ============================================
// 🔔 WAKE WORKER (NON-BLOCKING)
// ============================================

async function wakeWorker(jobId, action = 'new_job') {
  try {
    console.log(`🔔 Waking worker for job ${jobId} (${action})`);

    await axios.post(`${WORKER_BASE_URL}/wake-up`, {
      jobId,
      action,
      timestamp: Date.now()
    }, {
      timeout: 5000
    });

    console.log(`✅ Worker notified for job ${jobId}`);
  } catch (error) {
    console.warn(`⚠️ Could not wake worker: ${error.message}`);
    console.warn(`   Job ${jobId} will be processed when worker restarts`);
  }
}

// ============================================
// 🎬 GENERATE VIDEO ENDPOINT
// ============================================

app.post('/generate-video', async (req, res) => {
  let {
    user_id, userId,
    script, prompt,
    duration, videotype, voice,
    content_flow, media_type, media_mode,
    add_captions, caption_style,
    style_instruction,   // ← renamed from qwen_style_instruction
  } = req.body;

  const actualUserId      = user_id || userId;
  const actualContentFlow = content_flow || 'news';
  const actualMediaType   = media_type   || 'images';
  const actualMediaMode   = media_mode   || 'auto';

  // ─── Validation ───────────────────────────────────────────────────

  if (!actualUserId) {
    return res.status(400).json({ error: 'Missing user_id (Telegram ID).' });
  }

  if (!script && !prompt) {
    return res.status(400).json({ error: 'Provide either a script or a prompt.' });
  }

  if (!duration || typeof duration !== 'number') {
    return res.status(400).json({ error: 'Duration is required and must be a number.' });
  }

  if (duration < 1 || duration > 30) {
    return res.status(400).json({ error: 'Duration must be between 1 and 30 minutes.' });
  }

  if (!validVideoTypes.includes(videotype)) {
    return res.status(400).json({
      error: `Invalid videotype. Choose from: ${validVideoTypes.join(', ')}`
    });
  }

  if (!voice || !validVoices.includes(voice)) {
    return res.status(400).json({
      error: `Invalid voice. Choose from: ${validVoices.join(', ')}`
    });
  }

  if (!validContentFlows.includes(actualContentFlow)) {
    return res.status(400).json({
      error: `Invalid content_flow. Choose from: ${validContentFlows.join(', ')}`
    });
  }

  if (!validMediaTypes.includes(actualMediaType)) {
    return res.status(400).json({
      error: `Invalid media_type. Choose from: ${validMediaTypes.join(', ')}`
    });
  }

  if (!validMediaModes.includes(actualMediaMode)) {
    return res.status(400).json({
      error: `Invalid media_mode. Choose from: ${validMediaModes.join(', ')}`
    });
  }

  if (add_captions === true) {
    if (!caption_style || !validCaptionStyles.includes(caption_style)) {
      return res.status(400).json({
        error: `Invalid caption_style. Must be one of: ${validCaptionStyles.join(', ')}`
      });
    }
  }

  // ─── style_instruction validation ────────────────────────────────
  // Optional — works for all Gemini TTS voices.
  // Passed as the `prompt` field to the Cloud TTS API.

  if (style_instruction !== undefined && style_instruction !== null) {
    if (typeof style_instruction !== 'string') {
      return res.status(400).json({
        error: 'style_instruction must be a string.'
      });
    }
    if (style_instruction.length > 200) {
      return res.status(400).json({
        error: 'style_instruction must be 200 characters or fewer.'
      });
    }
  }

  // ─── Insert job ───────────────────────────────────────────────────

  try {
    const initialStatus = actualUserId === APPROVAL_REQUIRED_USER
      ? 'pending_approval'
      : 'pending';

    const result = await pool.query(
      `INSERT INTO jobs (
        user_id, prompt, script, duration, videotype, voice,
        content_flow, media_type, media_mode,
        add_captions, caption_style,
        style_instruction,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id`,
      [
        actualUserId,
        prompt             || null,
        script             || null,
        duration,
        videotype,
        voice,
        actualContentFlow,
        actualMediaType,
        actualMediaMode,
        add_captions       || false,
        caption_style      || null,
        style_instruction  || null,
        initialStatus,
      ]
    );

    const jobId = result.rows[0].id;
    console.log(
      `✅ [backend] Job ${jobId} created (status: ${initialStatus}) | ` +
      `voice: ${voice} | flow: ${actualContentFlow} | media: ${actualMediaType}`
    );

    // Respond immediately, then wake worker
    res.json({
      success:       true,
      message:       'Video generation job created.',
      jobId,
      status:        initialStatus,
      content_flow:  actualContentFlow,
      media_type:    actualMediaType,
      media_mode:    actualMediaMode,
      add_captions:  add_captions  || false,
      caption_style: caption_style || null,
    });

    wakeWorker(jobId, 'job_created').catch(err => {
      console.error(`Failed to wake worker: ${err.message}`);
    });

  } catch (error) {
    console.error('> [backend] Error creating job:', error);
    res.status(500).json({
      success: false,
      error:   'Failed to create job.'
    });
  }
});

// ============================================
// 🏥 HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'backend' });
});

// ============================================
// 🚀 START SERVER
// ============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend server running on port ${PORT}`);
  console.log(`🔗 Worker URL: ${WORKER_BASE_URL}`);
});
