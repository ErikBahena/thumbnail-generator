const express = require('express');
const { createFFmpeg, fetchFile } = require('@ffmpeg/ffmpeg');
const sharp = require('sharp');
const fastq = require('fastq');
const cors = require('cors');

const app = express();

// Explicitly allow all origins
app.use(
  cors({
    origin: '*', // Allow all origins
    methods: ['GET', 'POST', 'OPTIONS'], // Allow GET, POST, OPTIONS
    allowedHeaders: ['Content-Type', 'Authorization'], // Allow headers
    preflightContinue: false,
    optionsSuccessStatus: 204,
  }),
);

app.options('*', cors()); // Handle preflight requests

app.use(express.json());

const OUTPUT_WIDTH = 128;
const OUTPUT_HEIGHT = 72;
const TARGET_ASPECT_RATIO = 16 / 9;

// Create the FFmpeg instance
const ffmpeg = createFFmpeg({ log: true });

// Initialize FFmpeg instance
const ensureFFmpegIsLoaded = async () => {
  if (!ffmpeg.isLoaded()) {
    await ffmpeg.load();
  }
};

// Function to extract the main color (hue) of an image
const getMainHue = async (imageBuffer) => {
  const { dominant } = await sharp(imageBuffer).stats();
  return `rgb(${dominant.r},${dominant.g},${dominant.b})`;
};

// Function to process the video and generate a thumbnail
const processVideoThumbnail = async (url) => {
  await ensureFFmpegIsLoaded();

  const videoFile = await fetchFile(url);
  const inputFileName = 'input.mp4';
  const outputFileName = 'thumbnail.jpg';

  // Write the video file to FFmpeg's virtual file system
  ffmpeg.FS('writeFile', inputFileName, videoFile);

  // Use FFmpeg to extract a single frame from the 1-second mark
  await ffmpeg.run(
    '-i',
    inputFileName,
    '-ss',
    '00:00:01.000',
    '-frames:v',
    '1',
    outputFileName,
  );

  // Read the output file (thumbnail) from the virtual file system
  const thumbnailData = ffmpeg.FS('readFile', outputFileName);
  const thumbnailBuffer = Buffer.from(thumbnailData);

  // Get video metadata to calculate aspect ratio
  const metadata = await ffmpeg.run('-i', inputFileName);
  const regex = /(\d+)x(\d+)/;
  const match = regex.exec(metadata);
  const [width, height] = match
    ? [parseInt(match[1], 10), parseInt(match[2], 10)]
    : [0, 0];

  const aspectRatio = width / height;
  const requiresLetterboxing = aspectRatio !== TARGET_ASPECT_RATIO;

  let outputBuffer;

  try {
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
    return outputBuffer;
  } catch (err) {
    throw err;
  }
};

// Queue worker function to process video tasks
const worker = async (task, cb) => {
  try {
    const thumbnailBuffer = await processVideoThumbnail(task.url);
    cb(null, thumbnailBuffer);
  } catch (err) {
    cb(err);
  }
};

// Create a queue with 10 concurrent workers
const queue = fastq(worker, 10);

// Route to handle thumbnail generation
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

// Export the app to be used as a serverless function or standalone server
module.exports = (req, res) => {
  app(req, res);
};
