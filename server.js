const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 8080;

// FlareSolverr runs on localhost:8191 in the same container
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://localhost:8191/v1';

// Cache sessions per domain
const sessionCache = new Map();
const SESSION_TTL = 10 * 60 * 1000; // 10 minutes

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Health check
app.get('/health', async (req, res) => {
  let flaresolverrStatus = 'unknown';
  try {
    const fsHealth = await fetch('http://localhost:8191/health', { timeout: 5000 });
    if (fsHealth.ok) {
      flaresolverrStatus = 'ok';
    }
  } catch (e) {
    flaresolverrStatus = 'error: ' + e.message;
  }

  res.json({
    status: 'ok',
    service: 'railway-image-proxy',
    flaresolverr: flaresolverrStatus
  });
});

/**
 * Get or create a session for a domain, solving the challenge if needed
 */
async function getSessionForDomain(domain) {
  const cached = sessionCache.get(domain);
  if (cached && Date.now() - cached.timestamp < SESSION_TTL) {
    console.log(`[Cache] Using cached session for ${domain}`);
    return cached.sessionId;
  }

  const sessionId = `session_${domain.replace(/\./g, '_')}_${Date.now()}`;
  console.log(`[FlareSolverr] Creating session ${sessionId} for ${domain}...`);

  try {
    // First, solve the challenge on the main domain
    const response = await fetch(FLARESOLVERR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: 'request.get',
        url: `https://${domain}/`,
        session: sessionId,
        maxTimeout: 60000,
      }),
    });

    if (!response.ok) {
      throw new Error(`FlareSolverr HTTP error: ${response.status}`);
    }

    const data = await response.json();

    if (data.status !== 'ok') {
      throw new Error(data.message || 'FlareSolverr request failed');
    }

    console.log(`[FlareSolverr] Session ${sessionId} ready for ${domain}`);

    // Cache the session
    sessionCache.set(domain, {
      sessionId,
      timestamp: Date.now(),
    });

    return sessionId;
  } catch (error) {
    console.error(`[FlareSolverr] Error:`, error.message);
    throw error;
  }
}

/**
 * Fetch the image using FlareSolverr's browser session
 * The browser will handle cookies automatically
 */
async function fetchImageWithSession(imageUrl, sessionId) {
  console.log(`[FlareSolverr] Fetching image with session: ${imageUrl}`);

  const response = await fetch(FLARESOLVERR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cmd: 'request.get',
      url: imageUrl,
      session: sessionId,
      maxTimeout: 60000,
    }),
  });

  if (!response.ok) {
    throw new Error(`FlareSolverr HTTP error: ${response.status}`);
  }

  return await response.json();
}

/**
 * Destroy a session
 */
async function destroySession(sessionId) {
  try {
    await fetch(FLARESOLVERR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: 'sessions.destroy',
        session: sessionId,
      }),
    });
  } catch (e) {
    // Ignore cleanup errors
  }
}

/**
 * Extract binary image data from FlareSolverr response
 * FlareSolverr stores the response body, which for images should be binary
 */
function extractImageData(solution, imageUrl) {
  const response = solution.response;

  if (!response) {
    return null;
  }

  // Check if response is HTML (challenge page)
  if (typeof response === 'string' &&
      (response.includes('<!DOCTYPE') || response.includes('<html'))) {
    console.log(`[Extract] Got HTML instead of image`);
    return null;
  }

  // FlareSolverr returns the response as a string
  // For binary content like images, it should be the raw bytes
  const contentType = guessContentType(imageUrl);

  // Try to create a buffer from the response
  try {
    // The response might be encoded as latin1 for binary data
    const buffer = Buffer.from(response, 'latin1');

    // Verify it looks like an image (check magic bytes)
    if (isValidImage(buffer)) {
      return { buffer, contentType };
    }

    console.log(`[Extract] Response doesn't look like an image (${buffer.length} bytes, starts with: ${buffer.slice(0, 16).toString('hex')})`);
    return null;
  } catch (e) {
    console.error(`[Extract] Error creating buffer:`, e.message);
    return null;
  }
}

function guessContentType(url) {
  const ext = url.split('.').pop()?.toLowerCase().split('?')[0];
  const types = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'avif': 'image/avif',
  };
  return types[ext] || 'image/jpeg';
}

function isValidImage(buffer) {
  if (buffer.length < 4) return false;

  // JPEG magic bytes
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return true;
  }

  // PNG magic bytes
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return true;
  }

  // GIF magic bytes
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return true;
  }

  // WebP magic bytes (RIFF....WEBP)
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    return true;
  }

  return false;
}

/**
 * Main image proxy endpoint
 * GET /image?url=<encoded-url>
 */
app.get('/image', async (req, res) => {
  const imageUrl = req.query.url;

  if (!imageUrl) {
    return res.status(400).json({ error: 'url parameter required' });
  }

  if (!imageUrl.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  try {
    const domain = new URL(imageUrl).hostname;

    // Get session with solved challenge
    const sessionId = await getSessionForDomain(domain);

    // Fetch image using the session
    const data = await fetchImageWithSession(imageUrl, sessionId);

    if (data.status !== 'ok' || !data.solution) {
      // Clear cache and retry
      sessionCache.delete(domain);
      await destroySession(sessionId);
      throw new Error(data.message || 'Image fetch failed');
    }

    const imageData = extractImageData(data.solution, imageUrl);

    if (!imageData) {
      // Clear cache for retry
      sessionCache.delete(domain);
      return res.status(500).json({ error: 'Could not extract image data' });
    }

    console.log(`[Proxy] Success: ${imageData.contentType}, ${imageData.buffer.length} bytes`);

    res.set({
      'Content-Type': imageData.contentType,
      'Content-Length': imageData.buffer.length,
      'Cache-Control': 'public, max-age=86400, immutable',
    });

    return res.send(imageData.buffer);

  } catch (error) {
    console.error(`[Proxy] Error:`, error.message);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Base64 endpoint for Cloudinary uploads
 * GET /image/base64?url=<encoded-url>
 */
app.get('/image/base64', async (req, res) => {
  const imageUrl = req.query.url;

  if (!imageUrl) {
    return res.status(400).json({ success: false, error: 'url parameter required' });
  }

  try {
    const domain = new URL(imageUrl).hostname;

    // Get session with solved challenge
    const sessionId = await getSessionForDomain(domain);

    // Fetch image using the session
    const data = await fetchImageWithSession(imageUrl, sessionId);

    if (data.status !== 'ok' || !data.solution) {
      sessionCache.delete(domain);
      await destroySession(sessionId);
      return res.json({
        success: false,
        error: data.message || 'Image fetch failed'
      });
    }

    const imageData = extractImageData(data.solution, imageUrl);

    if (!imageData) {
      sessionCache.delete(domain);
      return res.json({
        success: false,
        error: 'Could not extract image data from response'
      });
    }

    const base64 = imageData.buffer.toString('base64');

    console.log(`[Base64] Success: ${imageData.contentType}, ${imageData.buffer.length} bytes`);

    return res.json({
      success: true,
      base64,
      contentType: imageData.contentType,
      size: imageData.buffer.length,
    });

  } catch (error) {
    console.error(`[Base64] Error:`, error.message);
    return res.json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Railway Image Proxy running on port ${PORT}`);
  console.log(`FlareSolverr URL: ${FLARESOLVERR_URL}`);
});
