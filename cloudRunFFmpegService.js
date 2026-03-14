import { execSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import https from 'https';
import AWS from 'aws-sdk';

AWS.config.update({ region: process.env.AWS_REGION });
const s3 = new AWS.S3();

async function downloadFile(url, filePath) {
    return new Promise((resolve, reject) => {
        const file = require('fs').createWriteStream(filePath);
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            require('fs').unlink(filePath, () => {});
            reject(err);
        });
    });
}

export const handler = async (event) => {
    console.log('Received event:', JSON.stringify(event, null, 2));

    try {
        const layerFiles = execSync('find /opt -name "*ffmpeg*" 2>/dev/null || true').toString();
        console.log('Available ffmpeg files in /opt:', layerFiles);
        const optContents = execSync('ls -la /opt/bin/ 2>/dev/null || echo "No /opt/bin found"').toString();
        console.log('Contents of /opt/bin:', optContents);
    } catch (e) {
        console.log('Could not list Layer contents:', e.message);
    }

    const startTime = Date.now();
    let downloadTime = 0;
    let ffmpegTime = 0;
    let uploadTime = 0;

    try {
        // Handle both test events and real API Gateway requests
        let { videoUrl, audioUrl, playlistId } = event;
        
        if (!videoUrl && event.body) {
            const body = JSON.parse(event.body);
            videoUrl = body.videoUrl;
            audioUrl = body.audioUrl;
            playlistId = body.playlistId;
        }

        if (!videoUrl || !audioUrl || !playlistId) {
            return {
                statusCode: 400,
                body: JSON.stringify({ success: false, error: 'Missing videoUrl, audioUrl, or playlistId' }),
            };
        }

        const inputVideoPath = '/tmp/input_video.mp4';
        const inputAudioPath = '/tmp/input_audio.webm';
        const outputVideoPath = '/tmp/output_merged.mp4';

        const s3BucketName = process.env.S3_BUCKET_NAME;
        if (!s3BucketName) {
            throw new Error('S3_BUCKET_NAME environment variable is not set.');
        }

        const downloadStart = Date.now();
        console.log(`Downloading video from: ${videoUrl}`);
        await downloadFile(videoUrl, inputVideoPath);
        console.log(`Downloading audio from: ${audioUrl}`);
        await downloadFile(audioUrl, inputAudioPath);
        downloadTime = Date.now() - downloadStart;
        console.log(`Files downloaded in ${downloadTime}ms`);

        const ffmpegStart = Date.now();
        console.log('Starting FFmpeg processing...');

        try {
            execSync('chmod +x /opt/bin/ffmpeg');
            execSync('chmod +x /opt/bin/ffprobe');
        } catch (e) {
            console.error('Error setting ffmpeg permissions:', e.message);
            throw e;
        }

        const ffmpegCommand = [
            '-i', inputVideoPath,
            '-i', inputAudioPath,
            '-filter_complex', '[0:a]volume=0.4[a1];[1:a]atrim=start=0.024[a_trim];[a_trim]asetpts=PTS-STARTPTS[a_reset];[a_reset]volume=1.5[a2];[a1][a2]amix=inputs=2:duration=longest[aout]',
            '-map', '0:v',
            '-map', '[aout]',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-y',
            outputVideoPath
        ];
        
        console.log(`Executing FFmpeg: /opt/bin/ffmpeg ${ffmpegCommand.join(' ')}`);
        execSync(`/opt/bin/ffmpeg ${ffmpegCommand.join(' ')}`, { stdio: 'inherit' });

        ffmpegTime = Date.now() - ffmpegStart;
        console.log(`FFmpeg processing completed in ${ffmpegTime}ms`);

        const uploadStart = Date.now();
        const fileContent = readFileSync(outputVideoPath);
        const s3Key = `published-videos/${playlistId}/merged_video.mp4`;

        const uploadParams = {
            Bucket: s3BucketName,
            Key: s3Key,
            Body: fileContent,
            ContentType: 'video/mp4',
            ACL: 'public-read'
        };

        const s3UploadResult = await s3.upload(uploadParams).promise();
        uploadTime = Date.now() - uploadStart;
        console.log(`File uploaded to S3 in ${uploadTime}ms: ${s3UploadResult.Location}`);

        unlinkSync(inputVideoPath);
        unlinkSync(inputAudioPath);
        unlinkSync(outputVideoPath);
        console.log('Temporary files cleaned up.');

        const totalTime = Date.now() - startTime;
        console.log(`Total Lambda execution time: ${totalTime}ms`);

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                publishedVideoUrl: s3UploadResult.Location,
                timing: {
                    download: downloadTime,
                    ffmpeg: ffmpegTime,
                    upload: uploadTime,
                    total: totalTime
                }
            }),
        };
    } catch (error) {
        console.error('Lambda error:', error);
        console.error('Lambda error details:', error.message, error.stack);
        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: error.message, stack: error.stack }),
        };
    }
};
