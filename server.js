const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const WORKER_BASE_URL = process.env.WORKER_BASE_URL || 'http://localhost:4000';

// ─────────────────────────────────────────────
// Valid voices — must stay in sync with
// voiceMap keys in audio-robot.js and
// ALL_VOICES in telegram-bot.js
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

const validContentFlows = ['news', 'listicle'];
const validMediaTypes = ['videos', 'videos_images'];
const validVideoTypes = ['reels', 'shorts', 'longform'];

const validCaptionStyles = [
  'Karaoke', 'Banger', 'Acid', 'Lovly', 'Marvel', 'Marker',
  'Neon Pulse', 'Beasty', 'Crazy', 'Safari', 'Popline', 'Desert',
  'Hook', 'Sky', 'Flamingo', 'Deep Diver B&W', 'New', 'Catchy',
  'From', 'Classic', 'Classic Big', 'Old Money', 'Cinema',
  'Midnight Serif', 'Aurora Ink'
];

// ============================================
// 🔔 WAKE WORKER (NON-BLOCKING)
// ============================================

async function wakeWorker(jobId, action = 'new_job') {
  try {
    axios.post(`${WORKER_BASE_URL}/wake-up`, {
      jobId,
      action,
      timestamp: Date.now()
    }, { timeout: 5000 }).catch(err => {
      console.warn(`⚠️ Could not wake worker: ${err.message}`);
    });

    console.log(`✅ Worker wake-up triggered for job ${jobId}`);
  } catch (error) {
    console.warn(`⚠️ Wake-up error: ${error.message}`);
  }
}

// ============================================
// 🎬 GENERATE VIDEO ENDPOINT
// ============================================

app.post('/generate-video', async (req, res) => {
  const {
    user_id,
    script,
    prompt,
    duration,
    videotype,
    voice,
    content_flow,
    media_type,
    add_captions,
    caption_style,
    qwen_style_instruction,
  } = req.body;

  const actualContentFlow = content_flow || 'news';
  const actualMediaType = media_type || 'videos';

  // ─── Validation ───────────────────────────────────────────────────

  if (!user_id) {
    return res.status(400).json({ error: 'Missing user_id.' });
  }

  if (!script && !prompt) {
    return res.status(400).json({ error: 'Provide either a script or a prompt.' });
  }

  if (!duration || typeof duration !== 'number' || duration < 1 || duration > 30) {
    return res.status(400).json({ error: 'Duration must be a number between 1 and 30.' });
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

  if (add_captions === true) {
    if (!caption_style || !validCaptionStyles.includes(caption_style)) {
      return res.status(400).json({
        error: `Invalid caption_style. Must be one of: ${validCaptionStyles.join(', ')}`
      });
    }
  }

  // ─── Validate qwen_style_instruction if present ───────────────────
  // Only warn — we don't block the job if it's a non-Qwen voice
  // because audio-robot.js ignores it for non-Qwen providers anyway
  if (qwen_style_instruction && typeof qwen_style_instruction !== 'string') {
    return res.status(400).json({
      error: 'qwen_style_instruction must be a string.'
    });
  }

  if (qwen_style_instruction && qwen_style_instruction.length > 200) {
    return res.status(400).json({
      error: 'qwen_style_instruction must be 200 characters or fewer.'
    });
  }

  // ─── Insert job ───────────────────────────────────────────────────

  try {
    const result = await pool.query(
      `INSERT INTO jobs (
        user_id, prompt, script, duration, videotype, voice,
        content_flow, media_type,
        add_captions, caption_style,
        qwen_style_instruction,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id`,
      [
        user_id,
        prompt || null,
        script || null,
        duration,
        videotype,
        voice,
        actualContentFlow,
        actualMediaType,
        add_captions || false,
        caption_style || null,
        qwen_style_instruction || null,
        'pending'
      ]
    );

    const jobId = result.rows[0].id;
    console.log(`✅ Job ${jobId} created for user ${user_id} | voice: ${voice} | flow: ${actualContentFlow}`);

    // Respond immediately
    res.json({
      success: true,
      message: 'Video generation job created.',
      jobId,
      status: 'pending',
      content_flow: actualContentFlow,
      media_type: actualMediaType,
      add_captions: add_captions || false,
      caption_style: caption_style || null,
    });

    // Wake worker after responding
    wakeWorker(jobId, 'job_created');

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
  res.json({
    status: 'healthy',
    service: 'backend'
  });
});

// ============================================
// 🚀 START SERVER
// ============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend server running on port ${PORT}`);
  console.log(`🔗 Worker URL: ${WORKER_BASE_URL}`);
});
