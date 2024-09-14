const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const fastq = require('fastq');
const { createClient } = require('redis');
const os = require('os');
const rateLimit = require('express-rate-limit');
// For Option B (Node.js image generation)

// For Option A (using a local image)

const cacheConfig = {
  enabled: true, // Enable or disable caching globally
  ttl: 60, // TTL for Redis cache (in seconds)
};

const queConfig = {
  concurrency: os.cpus().length, // Set concurrency to the number of CPU cores
};

const outputConfig = {
  OUTPUT_WIDTH: 640,
  OUTPUT_HEIGHT: 360,
  TARGET_ASPECT_RATIO: 16 / 9,
};

console.log({
  cacheConfig,
  queConfig,
  outputConfig,
});

const app = express();
app.use(cors());
app.use(express.json());

// Rate limiter middleware
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 60, // limit each IP to 60 requests per windowMs
});

app.use('/thumbnail', limiter);

// Redis client setup
const redisClient = createClient();

redisClient.on('error', (err) => console.error('Redis Client Error:', err));
redisClient.on('connect', () => console.log('Redis connected successfully'));

// Ensure Redis is connected
const connectRedis = async () => {
  if (!redisClient.isOpen) {
    console.log('Connecting to Redis...');
    await redisClient.connect();
    console.log('Redis connected.');
  }
};

// Connect to Redis during startup
(async () => {
  try {
    await connectRedis();
  } catch (err) {
    console.error('Failed to connect to Redis:', err);
  }
})();

// Process the video to generate a thumbnail directly from stream
const processVideoThumbnail = (url) => {
  return new Promise((resolve, reject) => {
    const ffmpegStream = ffmpeg(url)
      .on('error', (err) => {
        console.log('Unable to open input with ffmpeg');
        reject(err);
      })
      .outputOptions([
        '-vframes 1', // Capture the first frame
        '-threads 1', // Limit CPU threads per process
        `-vf scale=${outputConfig.OUTPUT_WIDTH}:${outputConfig.OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${outputConfig.OUTPUT_WIDTH}:${outputConfig.OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
      ])
      .format('mjpeg') // Use MJPEG for image output
      .pipe();

    const chunks = [];
    ffmpegStream.on('data', (chunk) => {
      chunks.push(chunk);
    });

    ffmpegStream.on('end', () => {
      const thumbnailBuffer = Buffer.concat(chunks);
      resolve(thumbnailBuffer);
    });
  });
};

// Queue worker to process video tasks
const worker = async (task, cb) => {
  try {
    if (!cacheConfig.enabled) {
      // Caching is disabled
      const thumbnailBuffer = await processVideoThumbnail(task.url);
      return cb(null, thumbnailBuffer);
    }

    // Redis cache logic
    const cachedThumbnailBase64 = await redisClient.get(task.url);

    if (cachedThumbnailBase64) {
      console.log(`Cache hit for URL: ${task.url}`);
      const cachedThumbnail = Buffer.from(cachedThumbnailBase64, 'base64');
      return cb(null, cachedThumbnail);
    } else {
      console.log(`Cache miss for URL: ${task.url}`);
      const thumbnailBuffer = await processVideoThumbnail(task.url);

      // Encode buffer to Base64 string before storing
      await redisClient.setEx(
        task.url,
        cacheConfig.ttl,
        thumbnailBuffer.toString('base64'),
      );
      return cb(null, thumbnailBuffer);
    }
  } catch (err) {
    cb(err);
  }
};

// Create a queue with concurrency set to the number of CPU cores
const queue = fastq(worker, queConfig.concurrency);

// Route to generate thumbnail and return as image/jpeg
app.get('/thumbnail', (req, res) => {
  try {
    const { url } = req.query;
    console.log('Processing video:', url);

    if (!url) {
      return res.status(400).json({ error: 'Missing or incorrect URL' });
    }

    res.set('Content-Type', 'image/jpeg'); // Set response type to JPEG

    queue.push({ url }, (err, result) => {
      if (err) {
        console.error('Error processing video:', err);
        return res.status(500).json({ error: 'Error processing video' });
      }
      // Send the result directly to the response
      res.end(result);
    });
  } catch (error) {
    console.error('Error processing video:', error);
    return res.status(500).json({ error: 'Error processing video' });
  }
});

app.get('/cache-status', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing or incorrect URL' });
  }

  try {
    const cachedThumbnailBase64 = await redisClient.get(url);

    if (cachedThumbnailBase64) {
      return res.json({ cacheHit: true });
    } else {
      return res.json({ cacheHit: false });
    }
  } catch (error) {
    console.error('Error checking cache status', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
