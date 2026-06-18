// backend/server.js
const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const axios = require('axios');
const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ✅ Worker webhook URL
const WORKER_BASE_URL = process.env.WORKER_BASE_URL || 'http://localhost:4000';

// ─────────────────────────────────────────────
// ✅ UPDATED: Valid voices with Qwen TTS
// Must stay in sync with voiceMap in audio-robot.js
// ─────────────────────────────────────────────
const validVoices = [
  // ElevenLabs voices
  'Max', 'Ashley', 'Ava', 'Roger', 'Lora',
  'Cassie', 'Ryan', 'Rachel', 'Missy', 'Amy',
  'Patrick', 'Andre', 'Stan', 'Lance', 'Alice',
  
  // Google Chirp 3 HD voices
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
  
  // Qwen — Dialect voices
  'Dylan', 'Eric', 'Jada', 'Li', 'Marcus',
  'Roy', 'Peter', 'Sunny', 'Rocky', 'Kiki',
];

const APPROVAL_REQUIRED_USER = 6646033752;
const validContentFlows = ['news', 'listicle'];
const validMediaTypes = ['images', 'videos', 'mixed'];
const validMediaModes = ['auto', 'manual'];

const validCaptionStyles = [
  'Karaoke', 'Banger', 'Acid', 'Lovly', 'Marvel', 'Marker',
  'Neon Pulse', 'Beasty', 'Crazy', 'Safari', 'Popline', 'Desert',
  'Hook', 'Sky', 'Flamingo', 'Deep Diver B&W', 'New', 'Catchy',
  'From', 'Classic', 'Classic Big', 'Old Money', 'Cinema',
  'Midnight Serif', 'Aurora Ink'
];

app.use(bodyParser.json());

// ─────────────────────────────────────────────
// ✅ FIXED: Wake Worker (non-blocking but with better logging)
// ─────────────────────────────────────────────
async function wakeWorker(jobId, action = 'new_job') {
  const wakeUrl = `${WORKER_BASE_URL}/wake-up`;
  
  console.log(`🔔 [WAKE] Attempting to wake worker at ${wakeUrl}`);
  console.log(`🔔 [WAKE] Job ID: ${jobId}, Action: ${action}`);
  
  // Use setImmediate to truly make this non-blocking
  setImmediate(async () => {
    try {
      const response = await axios.post(wakeUrl, {
        jobId,
        action,
        timestamp: Date.now()
      }, {
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' }
      });
      
      console.log(`✅ [WAKE] Worker responded: ${response.status} ${response.statusText}`);
      console.log(`✅ [WAKE] Response body:`, response.data);
      
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        console.error(`❌ [WAKE] Worker is DOWN at ${wakeUrl}`);
        console.error(`❌ [WAKE] Connection refused - check if worker service is running`);
      } else if (error.code === 'ETIMEDOUT') {
        console.error(`❌ [WAKE] Worker timeout at ${wakeUrl}`);
      } else if (error.response) {
        console.error(`❌ [WAKE] Worker error response: ${error.response.status}`);
        console.error(`❌ [WAKE] Error body:`, error.response.data);
      } else {
        console.error(`❌ [WAKE] Unexpected error:`, error.message);
      }
      console.warn(`⚠️  [WAKE] Job ${jobId} will be processed when worker polls next`);
    }
  });
}

// ─────────────────────────────────────────────
// 🎬 GENERATE VIDEO ENDPOINT
// ─────────────────────────────────────────────
app.post('/generate-video', async (req, res) => {
  let { 
    user_id, 
    userId, 
    script, 
    prompt, 
    duration, 
    videotype, 
    voice, 
    content_flow, 
    media_type, 
    media_mode,  
    add_captions, 
    caption_style,
    qwen_style_instruction
  } = req.body;
  
  const actualUserId = user_id || userId;
  const actualContentFlow = content_flow || 'news';
  const actualMediaType = media_type || 'images';
  const actualMediaMode = media_mode || 'auto';  

  // ─── Validation ───────────────────────────────────────────────────
  
  if (!actualUserId) {
    return res.status(400).json({ error: 'Missing user_id (Telegram ID).' });
  }
  
  if (!script && !prompt) {
    return res.status(400).json({ error: 'Provide either a script or a prompt.' });
  }
  
  if (!duration || typeof duration !== 'number') {
    return res.status(400).json({ 
      error: 'Duration is required and must be a number.' 
    });
  }
  
  if (duration < 1 || duration > 30) {
    return res.status(400).json({ 
      error: 'Duration must be between 1 and 30 minutes.' 
    });
  }
  
  if (!['reels', 'shorts', 'longform'].includes(videotype)) {
    return res.status(400).json({ 
      error: 'Invalid videotype. Choose reels, shorts, or longform.' 
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
  
  if (add_captions === true) {
    if (!caption_style || !validCaptionStyles.includes(caption_style)) {
      return res.status(400).json({ 
        error: `Invalid caption_style. Must be one of: ${validCaptionStyles.join(', ')}` 
      });
    }
  }
  
  // ─── Insert Job ───────────────────────────────────────────────────
  
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
        prompt || null, 
        script || null, 
        duration, 
        videotype, 
        voice,
        actualContentFlow, 
        actualMediaType,
        actualMediaMode,
        add_captions || false,      
        caption_style || null,
        qwen_style_instruction || null,
        initialStatus
      ]
    );
    
    const jobId = result.rows[0].id;
    console.log(`✅ [BACKEND] Job ${jobId} created for user ${actualUserId}`);
    console.log(`   Voice: ${voice} | Flow: ${actualContentFlow} | Status: ${initialStatus}`);
    if (qwen_style_instruction) {
      console.log(`   Qwen style: "${qwen_style_instruction}"`);
    }
    
    // ✅ FIRST: Respond to user immediately
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
      voice: voice,
      qwen_style_instruction: qwen_style_instruction || null
    });
    
    // ✅ THEN: Wake worker (truly non-blocking)
    console.log(`🔔 [BACKEND] Triggering worker wake-up for job ${jobId}...`);
    wakeWorker(jobId, 'job_created');
    
  } catch (error) {
    console.error('❌ [BACKEND] Error creating job:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to create job.' 
    });
  }
});

// ─────────────────────────────────────────────
// 🏥 HEALTH CHECK
// ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'celebrity-backend',
    worker_url: WORKER_BASE_URL,
    voices: {
      total: validVoices.length,
      elevenlabs: 15,
      google: 19,
      qwen: validVoices.length - 34
    }
  });
});

// ─────────────────────────────────────────────
// 🚀 START SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Celebrity Backend running on port ${PORT}`);
  console.log(`🔗 Worker webhook URL: ${WORKER_BASE_URL}`);
  console.log(`🎤 ${validVoices.length} voices available (incl. Qwen TTS)`);
  
  // ✅ Test worker connection on startup
  console.log(`🔍 Testing worker connection...`);
  axios.get(`${WORKER_BASE_URL}/health`, { timeout: 3000 })
    .then(response => {
      console.log(`✅ Worker is reachable: ${response.data.status}`);
    })
    .catch(err => {
      console.error(`❌ Worker unreachable at ${WORKER_BASE_URL}`);
      console.error(`   Error: ${err.message}`);
      console.error(`   Jobs will queue until worker is available`);
    });
});
