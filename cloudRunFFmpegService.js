// This file is meant to run INSIDE the Railway container (not in Base44/Deno Deploy)
// Deploy this as a standalone Node.js service on Railway with FFmpeg installed

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
  console.log('Initializing Storage with inline credentials from GCP_CREDS_BASE64...');
  const credJson = Buffer.from(process.env.GCP_CREDS_BASE64, 'base64').toString('utf-8');
  const credentials = JSON.parse(credJson);
  storage = new Storage({
    projectId: process.env.GCP_PROJECT_ID,
    credentials: credentials
  });
  console.log('Google Cloud Storage client initialized successfully.');
} else {
  console.warn('GCP_CREDS_BASE64 is not set. Falling back to default credentials.');
  storage = new Storage({
    projectId: process.env.GCP_PROJECT_ID
  });
}

app.post('/merge-video', async (req, res) => {
  const { videoUrl, audioUrl, playlistId, bucketName, callbackUrl } = req.body;

  if (!videoUrl || !audioUrl || !playlistId || !bucketName) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  // Respond immediately so Railway doesn't timeout the HTTP request
  res.json({ success: true, status: 'processing', playlistId });

  // Run the actual merge in the background
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

    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-i', videoPath,
        '-i', audioPath,
        '-filter_complex',
        '[0:a]volume=0.4[vid_a];[1:a]volume=1.5[rec_a];[vid_a][rec_a]amerge=inputs=2,pan=stereo|c0<c0+c2|c1<c1+c2[a_out]',
        '-map', '0:v',
        '-map', '[a_out]',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
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

    const publicUrl = `https://storage.googleapis.com/${bucketName}/${gcsFileName}`;
    console.log('Upload complete:', publicUrl);

    // Cleanup temp files
    [videoPath, audioPath, outputPath].forEach(p => {
      try { fs.unlinkSync(p); } catch (e) {}
    });

    // Notify callback
    if (callbackUrl) {
      try {
        console.log(`Calling callback: ${callbackUrl}`);
        await axios.post(callbackUrl, { playlistId, isCallback: true, mergedVideoUrl: publicUrl });
        console.log('Callback notified successfully');
      } catch (e) {
        console.error('Callback notification failed:', e.message);
      }
    }

  } catch (error) {
    console.error('Error during background processing:', error);

    [videoPath, audioPath, outputPath].forEach(p => {
      try { fs.unlinkSync(p); } catch (e) { }
    });
  }
});

// Helper: create a video slide from a pre-rendered PNG image URL
async function createSlideFromImage(imageUrl, outputPath, durationSecs, slideIndex) {
  const imagePath = outputPath.replace('.mp4', '.png');
  const imageRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
  fs.writeFileSync(imagePath, Buffer.from(imageRes.data));

  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-loop', '1',
      '-i', imagePath,
      '-f', 'lavfi', '-i', `aevalsrc=0:c=stereo:r=44100:duration=${durationSecs}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-vf', 'scale=1920:1080',
      '-r', '30',
      '-c:a', 'aac', '-b:a', '128k',
      '-t', String(durationSecs),
      '-y', outputPath
    ]);
    ff.stderr.on('data', d => console.log(`[slide-${slideIndex}] FFmpeg: ${d}`));
    ff.on('close', code => {
      try { fs.unlinkSync(imagePath); } catch (e) {}
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg slide from image exited with code ${code}`));
    });
    ff.on('error', reject);
  });
}

// Fallback: blank black slide (no image provided)
async function createBlankSlide(outputPath, durationSecs, slideIndex) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-f', 'lavfi', '-i', `color=c=black:size=1920x1080:rate=30:duration=${durationSecs}`,
      '-f', 'lavfi', '-i', `aevalsrc=0:c=stereo:r=44100:duration=${durationSecs}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-y', outputPath
    ]);
    ff.stderr.on('data', d => console.log(`[blank-slide-${slideIndex}] FFmpeg: ${d}`));
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`Blank slide failed: ${code}`)));
    ff.on('error', reject);
  });
}

// Concatenate multiple clips into a single video, with intro and separators
app.post('/concat-clips', async (req, res) => {
  const { clipUrls, playlistId, playlistName, bucketName, callbackUrl, slideDuration, slideImageUrls } = req.body;

  if (!clipUrls || !clipUrls.length || !playlistId || !bucketName) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  const slideSeconds = parseInt(slideDuration || 2, 10) || 2;

  // Respond immediately
  res.json({ success: true, status: 'processing', playlistId });

  const tempDir = '/tmp';
  const outputPath = path.join(tempDir, `concat_${playlistId}.mp4`);
  const clipPaths = [];

  try {
    console.log(`[concat-clips] Starting for playlist ${playlistId} with ${clipUrls.length} clips, slideSeconds=${slideSeconds}`);

    // Download all clips
    clipPaths = [];
    for (let i = 0; i < clipUrls.length; i++) {
      const clipPath = path.join(tempDir, `clip_${playlistId}_${i}.mp4`);
      console.log(`Downloading clip ${i + 1}/${clipUrls.length}...`);
      const clipRes = await axios.get(clipUrls[i], { responseType: 'stream' });
      await new Promise((resolve, reject) => {
        clipRes.data.pipe(fs.createWriteStream(clipPath))
          .on('finish', resolve)
          .on('error', reject);
      });
      clipPaths.push(clipPath);
    }

    // Re-encode all clips to uniform format (1920x1080, 30fps, aac)
    console.log('[concat-clips] Re-encoding clips to uniform format...');
    const reEncodedPaths = [];
    for (let i = 0; i < clipPaths.length; i++) {
      const reEncodedPath = path.join(tempDir, `reenc_${playlistId}_${i}.mp4`);
      await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', [
          '-i', clipPaths[i],
          '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
          '-r', '30',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '23',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ar', '44100',
          '-ac', '2',
          '-y',
          reEncodedPath
        ]);
        ff.stderr.on('data', d => console.log(`[reenc-${i}] ${d}`));
        ff.on('close', code => code === 0 ? resolve() : reject(new Error(`Re-encode clip ${i} failed`)));
        ff.on('error', reject);
      });
      reEncodedPaths.push(reEncodedPath);
    }

    // Create slides from pre-rendered PNGs (slideImageUrls[0] = intro, [1..n] = separators)
    console.log('[concat-clips] Creating slides from pre-rendered images...');
    const introSlidePath = path.join(tempDir, `slide_intro_${playlistId}.mp4`);
    if (slideImageUrls && slideImageUrls[0]) {
      await createSlideFromImage(slideImageUrls[0], introSlidePath, slideSeconds, 'intro');
    } else {
      await createBlankSlide(introSlidePath, slideSeconds, 'intro');
    }

    const separatorPaths = [];
    for (let i = 0; i < clipUrls.length; i++) {
      const sepPath = path.join(tempDir, `slide_sep_${playlistId}_${i}.mp4`);
      const imgUrl = slideImageUrls && slideImageUrls[i + 1];
      if (imgUrl) {
        await createSlideFromImage(imgUrl, sepPath, slideSeconds, `sep_${i}`);
      } else {
        await createBlankSlide(sepPath, slideSeconds, `sep_${i}`);
      }
      separatorPaths.push(sepPath);
    }

    console.log('All slides created, building concat list...');

    // Build ordered list: intro + (separator + clip) for each clip
    const allSegments = [introSlidePath];
    for (let i = 0; i < reEncodedPaths.length; i++) {
      allSegments.push(separatorPaths[i]);
      allSegments.push(reEncodedPaths[i]);
    }

    // Write concat list file
    const concatListPath = path.join(tempDir, `concat_list_${playlistId}.txt`);
    const concatContent = allSegments.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(concatListPath, concatContent);

    // Run FFmpeg to concatenate
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListPath,
        '-c', 'copy',
        '-y',
        outputPath
      ]);
      ffmpeg.stderr.on('data', (data) => console.log(`FFmpeg: ${data}`));
      ffmpeg.on('close', (code) => {
        if (code === 0) { console.log('[concat-clips] FFmpeg concat completed'); resolve(); }
        else reject(new Error(`FFmpeg exited with code ${code}`));
      });
      ffmpeg.on('error', reject);
    });

    // Upload to GCS
    console.log('[concat-clips] Uploading to GCS...');
    const bucket = storage.bucket(bucketName);
    const timestamp = Date.now();
    const gcsFileName = `playlists/${playlistId}/video_${timestamp}.mp4`;
    const file = bucket.file(gcsFileName);

    await file.save(fs.readFileSync(outputPath), {
      metadata: { contentType: 'video/mp4' }
    });

    const publicUrl = `https://storage.googleapis.com/${bucketName}/${gcsFileName}`;
    console.log('[concat-clips] Upload complete:', publicUrl);

    // Cleanup
    [...clipPaths, concatListPath, outputPath].forEach(p => {
      try { fs.unlinkSync(p); } catch (e) {}
    });

    // Notify callback
    if (callbackUrl) {
      try {
        console.log(`[concat-clips] Calling callback: ${callbackUrl}`);
        await axios.post(callbackUrl, { playlistId, isCallback: true, videoUrl: publicUrl });
        console.log('[concat-clips] Callback notified successfully');
      } catch (e) {
        console.error('[concat-clips] Callback notification failed:', e.message);
      }
    }

  } catch (error) {
    console.error('[concat-clips] Error:', error);
    clipPaths.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
    try { fs.unlinkSync(outputPath); } catch (e) {}
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Cloud Run FFmpeg Service listening on port ${PORT}`);
});
