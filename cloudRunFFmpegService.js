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

console.log('=== SERVICE STARTUP ===');
for (const key in process.env) {
  if (process.env.hasOwnProperty(key)) {
    if (key.includes('KEY') || key.includes('SECRET') || key.includes('CREDS')) {
      console.log(`- ${key}: [SET]`);
    } else {
      console.log(`- ${key}: ${process.env[key]}`);
    }
  }
}

let storage;
if (process.env.GCP_CREDS_BASE64) {
  try {
    const credentials = JSON.parse(Buffer.from(process.env.GCP_CREDS_BASE64, 'base64').toString('utf-8'));
    storage = new Storage({ projectId: process.env.GCP_PROJECT_ID, credentials });
    console.log('Storage initialized with GCP_CREDS_BASE64.');
  } catch (e) {
    console.error('ERROR: Failed to parse GCP_CREDS_BASE64:', e.message);
    storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
  }
} else {
  console.warn('GCP_CREDS_BASE64 not set. Using default credentials.');
  storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
}

app.post('/merge-video', async (req, res) => {
  const { videoUrl, audioUrl, playlistId, bucketName } = req.body;

  console.log('=== MERGE REQUEST RECEIVED ===');
  console.log('playlistId:', playlistId);
  console.log('bucketName:', bucketName);
  console.log('videoUrl:', videoUrl);
  console.log('audioUrl:', audioUrl);

  if (!videoUrl || !audioUrl || !playlistId || !bucketName) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  const tempDir = '/tmp';
  const videoPath = path.join(tempDir, `video_${playlistId}.mp4`);
  const audioPath = path.join(tempDir, `audio_${playlistId}.m4a`);
  const outputPath = path.join(tempDir, `merged_${playlistId}.mp4`);

  try {
    // STEP 1: Download files
    console.log('--- STEP 1: Downloading video and audio ---');
    console.log(`Downloading VIDEO from: ${videoUrl}`);
    console.log(`Downloading AUDIO from: ${audioUrl}`);

    const [videoRes, audioRes] = await Promise.all([
      axios.get(videoUrl, { responseType: 'stream' }),
      axios.get(audioUrl, { responseType: 'stream' })
    ]);

    console.log('Video response status:', videoRes.status);
    console.log('Audio response status:', audioRes.status);
    console.log('Video content-type:', videoRes.headers['content-type']);
    console.log('Audio content-type:', audioRes.headers['content-type']);
    console.log('Video content-length:', videoRes.headers['content-length']);
    console.log('Audio content-length:', audioRes.headers['content-length']);

    await new Promise((resolve, reject) => {
      videoRes.data.pipe(fs.createWriteStream(videoPath))
        .on('finish', resolve).on('error', reject);
    });
    console.log('Video saved to:', videoPath, '| Size:', fs.statSync(videoPath).size, 'bytes');

    await new Promise((resolve, reject) => {
      audioRes.data.pipe(fs.createWriteStream(audioPath))
        .on('finish', resolve).on('error', reject);
    });
    console.log('Audio saved to:', audioPath, '| Size:', fs.statSync(audioPath).size, 'bytes');

    // STEP 2: FFmpeg merge
    console.log('--- STEP 2: Starting FFmpeg merge ---');
    console.log('FFmpeg command: ffmpeg -i', videoPath, '-i', audioPath, '-c:v copy -c:a aac -b:a 128k -y', outputPath);

    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-i', videoPath,
        '-i', audioPath,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-y',
        outputPath
      ]);

      ffmpeg.stderr.on('data', (data) => {
        console.log(`FFmpeg: ${data}`);
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          console.log('FFmpeg merge completed successfully');
          console.log('Output file size:', fs.statSync(outputPath).size, 'bytes');
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      ffmpeg.on('error', reject);
    });

    // STEP 3: Upload to GCS
    console.log('--- STEP 3: Uploading merged video to GCS ---');
    const bucket = storage.bucket(bucketName);
    const timestamp = Date.now();
    const gcsFileName = `playlists/${playlistId}/merged_${timestamp}.mp4`;
    const file = bucket.file(gcsFileName);

    await file.save(fs.readFileSync(outputPath), {
      metadata: { contentType: 'video/mp4' }
    });

    const publicUrl = `https://storage.googleapis.com/${bucketName}/${gcsFileName}`;
    console.log('Upload complete. Public URL:', publicUrl);

    // STEP 4: Cleanup
    console.log('--- STEP 4: Cleanup ---');
    fs.unlinkSync(videoPath);
    fs.unlinkSync(audioPath);
    fs.unlinkSync(outputPath);
    console.log('Temp files cleaned up.');

    res.json({ success: true, video_url: publicUrl, playlistId });

  } catch (error) {
    console.error('=== ERROR ===', error.message);
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
