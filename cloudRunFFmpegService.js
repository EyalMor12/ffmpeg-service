// This file is meant to run INSIDE the Railway container (not in Base44/Deno Deploy)
const express = require('express');
const { spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Storage } = require('@google-cloud/storage');

const app = express();
app.use(express.json());

console.log('=== SERVICE STARTUP ===');
console.log('GCP_CREDS_BASE64:', process.env.GCP_CREDS_BASE64 ? 'SET ✓' : 'NOT SET ✗');
console.log('GCP_PROJECT_ID:', process.env.GCP_PROJECT_ID || 'NOT SET ✗');
console.log('GCS_BUCKET_NAME:', process.env.GCS_BUCKET_NAME || 'NOT SET ✗');

let storage;

if (process.env.GCP_CREDS_BASE64) {
  const credJson = Buffer.from(process.env.GCP_CREDS_BASE64, 'base64').toString('utf-8');
  const credentials = JSON.parse(credJson);
  storage = new Storage({ projectId: process.env.GCP_PROJECT_ID, credentials });
  console.log('Google Cloud Storage client initialized successfully.');
} else {
  console.warn('GCP_CREDS_BASE64 is not set. Falling back to default credentials.');
  storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
}

app.post('/merge-video', async (req, res) => {
  const { videoUrl, audioUrl, playlistId, bucketName, callbackUrl } = req.body;

  if (!videoUrl || !audioUrl || !playlistId || !bucketName) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  // Respond immediately so the HTTP request doesn't timeout
  res.json({ success: true, status: 'processing', playlistId });

  const tempDir = '/tmp';
  const videoPath = path.join(tempDir, `video_${playlistId}.mp4`);
  const audioPath = path.join(tempDir, `audio_${playlistId}.m4a`);
  const outputPath = path.join(tempDir, `merged_${playlistId}.mp4`);

  try {
    console.log(`Starting merge for playlist ${playlistId}`);

    const [videoRes, audioRes] = await Promise.all([
      axios.get(videoUrl, { responseType: 'stream' }),
      axios.get(audioUrl, { responseType: 'stream' })
    ]);

    await new Promise((resolve, reject) => {
      videoRes.data.pipe(fs.createWriteStream(videoPath)).on('finish', resolve).on('error', reject);
    });

    await new Promise((resolve, reject) => {
      audioRes.data.pipe(fs.createWriteStream(audioPath)).on('finish', resolve).on('error', reject);
    });

    console.log('Files downloaded, starting FFmpeg merge...');

    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-i', videoPath, '-i', audioPath,
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-shortest', '-y', outputPath
      ]);
      ffmpeg.stderr.on('data', (data) => console.log(`FFmpeg: ${data}`));
      ffmpeg.on('close', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg exited with code ${code}`)));
      ffmpeg.on('error', reject);
    });

    console.log('FFmpeg done, uploading to GCS...');
    const bucket = storage.bucket(bucketName);
    const gcsFileName = `playlists/${playlistId}/merged_${Date.now()}.mp4`;
    const file = bucket.file(gcsFileName);

    await file.save(fs.readFileSync(outputPath), {
      metadata: { contentType: 'video/mp4' }
    });

    const publicUrl = `https://storage.googleapis.com/${bucketName}/${gcsFileName}`;
    console.log('Upload complete:', publicUrl);

    [videoPath, audioPath, outputPath].forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });

    if (callbackUrl) {
      try {
        console.log(`Calling callback: ${callbackUrl}`);
        await axios.post(callbackUrl, { playlistId, video_url: publicUrl });
        console.log('Callback notified successfully');
      } catch (e) {
        console.error('Callback notification failed:', e.message);
      }
    }

  } catch (error) {
    console.error('Error during background processing:', error);
    [videoPath, audioPath, outputPath].forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`FFmpeg Service listening on port ${PORT}`));

