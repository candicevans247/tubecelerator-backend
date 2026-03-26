// backend/server.js - ADD content_flow support
const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const validVoices = [
  'Max', 'Ashley', 'Ava', 'Roger', 'Lora',
  'Cassie', 'Ryan', 'Rachel', 'Missy', 'Amy',
  'Patrick', 'Andre', 'Stan', 'Lance', 'Alice',
  'Liz', 'Dave', 'Candice', 'Autumn', 'Desmond', 'Charlotte',
  'Ace', 'Liam', 'Keisha', 'Kent', 'Daisy', 'Lucy',
  'Linda', 'Jamal', 'Sydney', 'Sally', 'Violet', 'Rhihanon',
  'Mark'
];

const APPROVAL_REQUIRED_USER = 6646033752;

// ✅ NEW: Valid content flows
const validContentFlows = ['news', 'listicle'];

app.use(bodyParser.json());

// UPDATED: job creation endpoint with content_flow
app.post('/generate-video', async (req, res) => {
  let { 
    user_id, userId, script, prompt, duration, videotype, voice, 
    content_flow, media_type, media_mode,  
    add_captions, caption_style
  } = req.body;
  
  const actualUserId = user_id || userId;
  const actualContentFlow = content_flow || 'news';
  const actualMediaType = media_type || 'images';
  const actualMediaMode = media_mode || 'auto';  

  // Existing validation...
  if (!actualUserId) {
    return res.status(400).json({ error: 'Missing user_id (Telegram ID).' });
  }
  if (!script && !prompt) {
    return res.status(400).json({ error: 'Provide either a script or a prompt.' });
  }
 // ✅ NEW: Accept any duration between 1-30 minutes
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
    return res.status(400).json({ error: 'Invalid videotype. Choose reels, shorts, longform.' });
  }
  if (!voice || !validVoices.includes(voice)) {
    return res.status(400).json({ error: `Invalid voice. Choose from: ${validVoices.join(', ')}` });
  }
    if (!validContentFlows.includes(actualContentFlow)) {
    return res.status(400).json({ error: `Invalid content_flow. Choose from: ${validContentFlows.join(', ')}` });
  }
  
  // ✅ NEW: Validate media_type (simplified)
  const validMediaTypes = ['images', 'videos', 'mixed'];
  if (!validMediaTypes.includes(actualMediaType)) {
    return res.status(400).json({ 
      error: 'Invalid media_type. Choose images, videos, or mixed.' 
    });
  }
  
  // ✅ NEW: Validate media_mode
  if (!['auto', 'manual'].includes(actualMediaMode)) {
    return res.status(400).json({ error: 'Invalid media_mode. Choose auto or manual.' });
  }
  
  // ✅ NEW: Block maintenance modes
  if (actualMediaType === 'videos' || actualMediaType === 'mixed') {
    return res.status(503).json({ 
      error: 'UNDER MAINTENANCE, CHECK BACK LATER',
      message: 'Videos Only and Mixed modes are currently under maintenance. Please use Images Only.'
    });
  }
  
  // ✅ NEW: Validate caption fields
  if (add_captions === true) {
    const validStyles = ['Karaoke', 'Banger', 'Acid', 'Lovly', 'Marvel', 'Marker',
  'Neon Pulse', 'Beasty', 'Crazy', 'Safari', 'Popline', 'Desert',
  'Hook', 'Sky', 'Flamingo', 'Deep Diver B&W', 'New', 'Catchy',
  'From', 'Classic', 'Classic Big', 'Old Money', 'Cinema',
  'Midnight Serif', 'Aurora Ink'];
    if (!caption_style || !validStyles.includes(caption_style)) {
      return res.status(400).json({ 
        error: 'Invalid caption_style. Must be one of: ' + validStyles.join(', ') 
      });
    }
  }
  
  try {
    const initialStatus = actualUserId === APPROVAL_REQUIRED_USER ? 'pending_approval' : 'pending';
    
        const result = await pool.query(
      `INSERT INTO jobs (
        user_id, prompt, script, duration, videotype, voice, 
        content_flow, media_type, media_mode,  -- ✅ CHANGED
        add_captions, caption_style,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id`,
      [
        actualUserId, 
        prompt || null, 
        script || null, 
        duration, 
        videotype, 
        voice,
        actualContentFlow, 
        actualMediaType,      // ✅ CHANGED position
        actualMediaMode,      // ✅ NEW
        add_captions || false,      
        caption_style || null,      
        initialStatus
      ]
    );
    
    const jobId = result.rows[0].id;
    console.log(`> [backend] Job ${jobId} created (captions: ${add_captions ? caption_style : 'disabled'})`);
    
       res.json({
      success: true,
      message: 'Celebrity video generation job created.',
      jobId,
      status: initialStatus,
      content_flow: actualContentFlow,
      media_type: actualMediaType,      
      media_mode: actualMediaMode,      
      add_captions: add_captions || false,
      caption_style: caption_style || null
    });
  } catch (error) {
    console.error('> [backend] Error creating job:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to create job.' 
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'backend' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
