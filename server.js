// backend/server.js
const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const axios = require('axios');
const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const WORKER_BASE_URL = process.env.WORKER_BASE_URL || 'http://localhost:4000';

// ─────────────────────────────────────────────
// Valid voices — must stay in sync with
// voiceMap keys in audio-robot.js
// ─────────────────────────────────────────────
const validVoices = [
  // Google Chirp 3 HD
  'Liz', 'Dave', 'Candice', 'Autumn', 'Desmond',
  'Charlotte', 'Ace', 'Liam', 'Keisha', 'Kent',
  'Daisy', 'Lucy', 'Linda', 'Jamal', 'Sydney',
  'Sally', 'Violet', 'Rhihanon', 'Mark',

  // Qwen — Instruct-compatible female
  'Cherry', 'Serena', 'Maia', 'Vivian', 'Bella',
  'Mia', 'Seren', 'Stella', 'Chelsie', 'Momo',
  'Bellona', 'Bunny', 'Elias', 'Nini',

  // Qwen — Instruct-compatible male
  'Ethan', 'Moon', 'Kai', 'EldricSage', 'Mochi',
  'Vincent', 'Neil', 'Arthur', 'Pip', 'Nofish',

  // Qwen — Flash-only female
  'Jennifer', 'Katerina', 'Sonrisa', 'Sohee', 'OnoAnna',

  // Qwen — Flash-only male
  'QwenRyan', 'Aiden', 'Bodega', 'Alek', 'Dolce',
  'Lenn', 'Emilien', 'QwenAndre', 'RadioGol',

  // Qwen — Dialect
  'Dylan', 'Eric', 'Jada', 'Li', 'Marcus',
  'Roy', 'Peter', 'Sunny', 'Rocky', 'Kiki',
];

const APPROVAL_REQUIRED_USER = 6646033752;
const validContentFlows = ['news', 'listicle'];
const validMediaTypes = ['images', 'videos', 'mixed'];
const validMediaModes = ['auto', 'manual'];
const validVideoTypes = ['reels', 'shorts', 'longform'];

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
      timeout: 5000 // Don't wait too long
    });
    
    console.log(`✅ Worker notified for job ${jobId}`);
  } catch (error) {
    // Don't fail the request if worker is down
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
    qwen_style_instruction,           // ← NEW
  } = req.body;

  const actualUserId       = user_id || userId;
  const actualContentFlow  = content_flow || 'news';
  const actualMediaType    = media_type   || 'images';
  const actualMediaMode    = media_mode   || 'auto';

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

  // ─── qwen_style_instruction validation ────────────────────────────
  // Optional — only used when a Qwen voice is selected.
  // audio-robot.js will silently ignore it for non-Qwen voices.

  if (qwen_style_instruction !== undefined && qwen_style_instruction !== null) {
    if (typeof qwen_style_instruction !== 'string') {
      return res.status(400).json({
        error: 'qwen_style_instruction must be a string.'
      });
    }
    if (qwen_style_instruction.length > 200) {
      return res.status(400).json({
        error: 'qwen_style_instruction must be 200 characters or fewer.'
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
        qwen_style_instruction,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id`,
      [
        actualUserId,
        prompt  || null,
        script  || null,
        duration,
        videotype,
        voice,
        actualContentFlow,
        actualMediaType,
        actualMediaMode,
        add_captions || false,
        caption_style || null,
        qwen_style_instruction || null,   // ← NEW
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
      success: true,
      message: 'Celebrity video generation job created.',
      jobId,
      status: initialStatus,
      content_flow: actualContentFlow,
      media_type: actualMediaType,
      media_mode: actualMediaMode,
      add_captions: add_captions || false,
      caption_style: caption_style || null,
    });

    wakeWorker(jobId, 'job_created').catch(err => {
      console.error(`Failed to wake worker: ${err.message}`);
    });

  } catch (error) {
    console.error('> [backend] Error creating job:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create job.'
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
