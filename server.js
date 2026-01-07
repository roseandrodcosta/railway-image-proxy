const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// FlareSolverr URL
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://localhost:8191/v1';

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
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'railway-image-proxy' });
});

/**
 * Use FlareSolverr to fetch image directly
 * This ensures the same IP is used for both challenge solving AND image download
 */
async function fetchImageViaFlareSolverr(imageUrl) {
  console.log(`[FlareSolverr] Fetching image directly: ${imageUrl}`);

  const response = await fetch(FLARESOLVERR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cmd: 'request.get',
      url: imageUrl,
      maxTimeout: 60000,
      // Request raw download for binary content
      download: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`FlareSolverr HTTP error: ${response.status}`);
  }

  const data = await response.json();

  if (data.status !== 'ok' || !data.solution) {
    throw new Error(data.message || 'FlareSolverr request failed');
  }

  // FlareSolverr returns the response content
  // For images, this should be base64 encoded if download: true is used
  // Otherwise it's in solution.response
  return data.solution;
}

/**
 * Alternative: Use session-based approach
 * Create a session, solve challenge on main domain, then fetch image
 */
async function fetchImageWithSession(imageUrl) {
  const domain = new URL(imageUrl).hostname;
  const sessionId = `img_${domain.replace(/\./g, '_')}`;

  console.log(`[Session] Using session ${sessionId} for ${domain}`);

  // Step 1: Create/reuse session and solve challenge on main domain
  const challengeResponse = await fetch(FLARESOLVERR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cmd: 'request.get',
      url: `https://${domain}/`,
      session: sessionId,
      maxTimeout: 60000,
    }),
  });

  if (!challengeResponse.ok) {
    throw new Error(`FlareSolverr challenge HTTP error: ${challengeResponse.status}`);
  }

  const challengeData = await challengeResponse.json();

  if (challengeData.status !== 'ok') {
    throw new Error(challengeData.message || 'Challenge failed');
  }

  console.log(`[Session] Challenge solved, now fetching image...`);

  // Step 2: Now fetch the image using the same session (same browser, same cookies, same IP)
  const imageResponse = await fetch(FLARESOLVERR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cmd: 'request.get',
      url: imageUrl,
      session: sessionId,
      maxTimeout: 60000,
    }),
  });

  if (!imageResponse.ok) {
    throw new Error(`FlareSolverr image HTTP error: ${imageResponse.status}`);
  }

  const imageData = await imageResponse.json();

  if (imageData.status !== 'ok' || !imageData.solution) {
    // Clean up session on failure
    await destroySession(sessionId);
    throw new Error(imageData.message || 'Image fetch failed');
  }

  return imageData.solution;
}

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
 * Extract image from FlareSolverr response
 * FlareSolverr returns HTML by default, but for images we need the raw data
 */
function extractImageFromResponse(solution, imageUrl) {
  // If response looks like base64 image data
  if (solution.response && !solution.response.startsWith('<') && !solution.response.startsWith('{')) {
    // Might be raw binary - try to decode
    return {
      buffer: Buffer.from(solution.response, 'binary'),
      contentType: guessContentType(imageUrl),
    };
  }

  // Check if there's a headers object with content-type
  const contentType = solution.headers?.['content-type'] || guessContentType(imageUrl);

  // FlareSolverr may return the image as part of the response
  if (solution.response) {
    // Try to extract the image data
    const response = solution.response;

    // If it's HTML, the image fetch failed (got Cloudflare page)
    if (response.includes('<!DOCTYPE') || response.includes('<html')) {
      return null;
    }

    // Otherwise, assume it's binary image data
    return {
      buffer: Buffer.from(response, 'binary'),
      contentType,
    };
  }

  return null;
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
    // Use session-based approach for proper IP binding
    const solution = await fetchImageWithSession(imageUrl);
    const imageData = extractImageFromResponse(solution, imageUrl);

    if (!imageData) {
      console.error(`[Proxy] Could not extract image from response`);
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
    const solution = await fetchImageWithSession(imageUrl);
    const imageData = extractImageFromResponse(solution, imageUrl);

    if (!imageData) {
      return res.json({ success: false, error: 'Could not extract image data - got HTML instead of image' });
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
