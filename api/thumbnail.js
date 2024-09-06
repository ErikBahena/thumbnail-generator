const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const fastq = require('fastq');
const cors = require('cors');
const { VercelRequest, VercelResponse } = require('@vercel/node');

const app = express();

app.use(express.json());
app.use(cors());

const OUTPUT_WIDTH = 128;
const OUTPUT_HEIGHT = 72;
const TARGET_ASPECT_RATIO = 16 / 9;

const getMainHue = async (imageBuffer) => {
  const { dominant } = await sharp(imageBuffer).stats();
  return `rgb(${dominant.r},${dominant.g},${dominant.b})`;
};

const processVideoThumbnail = async (url) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(url, (err, metadata) => {
      if (err) return reject(err);

      const videoStream = metadata.streams.find((stream) => stream.codec_type === 'video');
      if (!videoStream) return reject(new Error('No video stream found'));

      const { width, height } = videoStream;
      const aspectRatio = width / height;

      const requiresLetterboxing = aspectRatio !== TARGET_ASPECT_RATIO;

      const ffmpegCommand = ffmpeg(url)
        .on('error', reject)
        .inputOptions(['-ss 00:00:01.000'])
        .outputOptions(['-frames:v 1'])
        .format('image2pipe')
        .pipe();

      const chunks = [];
      ffmpegCommand.on('data', (chunk) => chunks.push(chunk));

      ffmpegCommand.on('end', async () => {
        const thumbnailBuffer = Buffer.concat(chunks);

        try {
          let outputBuffer;
          if (requiresLetterboxing) {
            const mainHue = await getMainHue(thumbnailBuffer);
            outputBuffer = await sharp(thumbnailBuffer)
              .resize({
                width: OUTPUT_WIDTH,
                height: OUTPUT_HEIGHT,
                fit: sharp.fit.contain,
                background: mainHue,
              })
              .jpeg()
              .toBuffer();
          } else {
            outputBuffer = await sharp(thumbnailBuffer)
              .resize({
                width: OUTPUT_WIDTH,
                height: OUTPUT_HEIGHT,
              })
              .jpeg()
              .toBuffer();
          }

          resolve(outputBuffer);
        } catch (err) {
          reject(err);
        }
      });
    });
  });
};

const worker = async (task, cb) => {
  try {
    const thumbnailBuffer = await processVideoThumbnail(task.url);
    cb(null, thumbnailBuffer);
  } catch (err) {
    cb(err);
  }
};

const queue = fastq(worker, 10);

app.post('/generate-thumbnail', (req, res) => {
  const { url, type } = req.body;
  if (!url || !type || type !== 'video') {
    return res.status(400).json({ error: 'Missing or incorrect URL/type' });
  }

  queue.push({ url, type }, (err, result) => {
    if (err) {
      return res.status(500).json({ error: 'Error processing video' });
    }
    res.set('Content-Type', 'image/jpeg');
    res.send(result);
  });
});

module.exports = (req, res) => {
  app(req, res); // Hand over the Express app to Vercel's handler
};
