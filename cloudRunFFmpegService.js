// This file is meant to run INSIDE the GCP Cloud Run container (not in Base44/Deno Deploy)
// Deploy this as a standalone Node.js service on GCP Cloud Run with FFmpeg installed

const express = require('express');
const { spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Storage } = require('@google-cloud/storage');

const app = express();
app.use(express.json());

// --- Start of added diagnostic logging and direct credential passing ---
console.log('=== SERVICE STARTUP ===');
console.log('Environment Variables at startup:');
for (const key in process.env) {
  if (process.env.hasOwnProperty(key)) {
    // Log sensitive variables without their full value, or mask them
    if (key.includes('KEY') || key.includes('SECRET') || key.includes('CREDS')) {
      console.log(`- ${key}: [SET - value not displayed for security]`);
    } else {
      console.log(`- ${key}: ${process.env[key]}`);
    }
  }
}

let storage;
if (process.env.GCP_CREDS_BASE64) {
  console.log('GCP_CREDS_BASE64 is set. Initializing Storage with direct credentials.');
  try {
    const credentials = JSON.parse(Buffer.from(process.env.GCP_CREDS_BASE64, 'base64').toString('utf-8'));
    storage = new Storage({
      projectId: process.env.GCP_PROJECT_ID,
      credentials: credentials
    });
    console.log('Google Cloud Storage client initialized successfully with direct credentials.');
  } catch (e) {
    console.error('ERROR: Failed to parse GCP_CREDS_BASE64 or initialize Storage:', e.message);
    // Fallback or exit if critical
    storage = new Storage({ projectId: process.env.GCP_PROJECT_ID }); // Fallback to default, which might fail
  }
} else {
  console.warn('GCP_CREDS_BASE64 is NOT set. Initializing Storage with default credentials (may fail).');
  storage = new Storage({
    projectId: process.env.GCP_PROJECT_ID
  });
}
// --- End of added diagnostic logging and direct credential passing ---

app.post('/merge-video', async (req, res) => {
  const { videoUrl, audioUrl, playlistId, bucketName } = req.body;

  if (!videoUrl || !audioUrl || !playlistId || !bucketName) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  const tempDir = '/tmp';
  const videoPath = path.join(tempDir, `video_${playlistId}.mp4`);
  const audioPath = path.join(tempDir, `audio_${playlistId}.m4a`);
  const outputPath = path.join(tempDir, `merged_${playlistId}.mp4`);

  try {
    console.log(`Starting merge for playlist ${playlistId}`);

    // Download video and audio
    console.log('Downloading video and audio files...');
    const [videoRes, audioRes] = await Promise.all([
      axios.get(videoUrl, { responseType: 'stream' }),
      axios.get(audioUrl, { responseType: 'stream' })
    ]);

    // Save files to temp directory
    await new Promise((resolve, reject) => {
      videoRes.data.pipe(fs.createWriteStream(videoPath))
        .on('finish', resolve)
        .on('error', reject);
    });

    await new Promise((resolve, reject) => {
      audioRes.data.pipe(fs.createWriteStream(audioPath))
        .on('finish', resolve)
        .on('error', reject);
    });

    console.log('Files downloaded, starting FFmpeg merge...');

    // Run FFmpeg to merge video and audio
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-i', videoPath,
        '-i', audioPath,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-shortest',
        '-y',
        outputPath
      ]);

      ffmpeg.stderr.on('data', (data) => {
        console.log(`FFmpeg: ${data}`);
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          console.log('FFmpeg merge completed successfully');
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      ffmpeg.on('error', reject);
    });

    // Upload merged video to GCS
    console.log('Uploading merged video to GCS...');
    const bucket = storage.bucket(bucketName);
    const timestamp = Date.now();
    const gcsFileName = `playlists/${playlistId}/merged_${timestamp}.mp4`;
    const file = bucket.file(gcsFileName);

    await file.save(fs.readFileSync(outputPath), {
      metadata: { contentType: 'video/mp4' }
    });

    // Removed: await file.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucketName}/${gcsFileName}`;

    console.log('Upload complete');

    // Cleanup temp files
    fs.unlinkSync(videoPath);
    fs.unlinkSync(audioPath);
    fs.unlinkSync(outputPath);

    res.json({
      success: true,
      video_url: publicUrl,
      playlistId
    });

  } catch (error) {
    console.error('Error during processing:', error);

    // Cleanup on error
    [videoPath, audioPath, outputPath].forEach(p => {
      try { fs.unlinkSync(p); } catch (e) { }
    });

    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Cloud Run FFmpeg Service listening on port ${PORT}`);
})
