const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 8080;

// FlareSolverr runs on localhost:8191 in the same container
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://localhost:8191/v1';

// Cache cookies per domain to avoid solving challenges repeatedly
const cookieCache = new Map();
const COOKIE_TTL = 10 * 60 * 1000; // 10 minutes

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
  // Also check if FlareSolverr is healthy
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
 * Get cookies from FlareSolverr for a domain
 */
async function getCookies(domain) {
  // Check cache first
  const cached = cookieCache.get(domain);
  if (cached && Date.now() - cached.timestamp < COOKIE_TTL) {
    console.log(`[Cache] Using cached cookies for ${domain}`);
    return cached;
  }

  console.log(`[FlareSolverr] Solving challenge for ${domain}...`);

  try {
    const response = await fetch(FLARESOLVERR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: 'request.get',
        url: `https://${domain}/`,
        maxTimeout: 60000,
      }),
    });

    if (!response.ok) {
      throw new Error(`FlareSolverr HTTP error: ${response.status}`);
    }

    const data = await response.json();

    if (data.status !== 'ok' || !data.solution) {
      throw new Error(data.message || 'FlareSolverr request failed');
    }

    const result = {
      cookies: data.solution.cookies || [],
      userAgent: data.solution.userAgent,
      timestamp: Date.now(),
    };

    // Cache the cookies
    cookieCache.set(domain, result);
    console.log(`[FlareSolverr] Got ${result.cookies.length} cookies for ${domain}`);

    return result;
  } catch (error) {
    console.error(`[FlareSolverr] Error:`, error.message);
    throw error;
  }
}

/**
 * Fetch image using cookies from the same container/IP
 */
async function fetchImageWithCookies(url, cookies, userAgent) {
  const cookieHeader = cookies
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  console.log(`[Fetch] Downloading image: ${url}`);

  const response = await fetch(url, {
    headers: {
      'Cookie': cookieHeader,
      'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': new URL(url).origin + '/',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'image',
      'sec-fetch-mode': 'no-cors',
      'sec-fetch-site': 'same-origin',
    },
  });

  return response;
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

    // Step 1: Get cookies from FlareSolverr
    const { cookies, userAgent } = await getCookies(domain);

    // Step 2: Fetch the image (from same container = same IP as FlareSolverr)
    const imageResponse = await fetchImageWithCookies(imageUrl, cookies, userAgent);

    if (!imageResponse.ok) {
      // Clear cache and retry once if we get a 403
      if (imageResponse.status === 403) {
        console.log(`[Proxy] Got 403, clearing cache and retrying...`);
        cookieCache.delete(domain);
        const freshCookies = await getCookies(domain);
        const retryResponse = await fetchImageWithCookies(imageUrl, freshCookies.cookies, freshCookies.userAgent);

        if (!retryResponse.ok) {
          return res.status(retryResponse.status).json({
            error: `Image fetch failed after retry: ${retryResponse.status}`
          });
        }

        return await streamImageResponse(retryResponse, res, imageUrl);
      }

      return res.status(imageResponse.status).json({
        error: `Image fetch failed: ${imageResponse.status}`
      });
    }

    return await streamImageResponse(imageResponse, res, imageUrl);

  } catch (error) {
    console.error(`[Proxy] Error:`, error.message);
    return res.status(500).json({ error: error.message });
  }
});

async function streamImageResponse(response, res, imageUrl) {
  const contentType = response.headers.get('content-type') || 'application/octet-stream';

  // Verify it's an image
  if (!contentType.startsWith('image/')) {
    console.error(`[Proxy] Got non-image content: ${contentType}`);
    const domain = new URL(imageUrl).hostname;
    cookieCache.delete(domain);
    return res.status(500).json({
      error: 'Received non-image content',
      contentType
    });
  }

  const buffer = await response.buffer();
  console.log(`[Proxy] Success: ${contentType}, ${buffer.length} bytes`);

  res.set({
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    'Cache-Control': 'public, max-age=86400, immutable',
  });

  return res.send(buffer);
}

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
    const { cookies, userAgent } = await getCookies(domain);
    let imageResponse = await fetchImageWithCookies(imageUrl, cookies, userAgent);

    // Retry on 403
    if (imageResponse.status === 403) {
      console.log(`[Base64] Got 403, clearing cache and retrying...`);
      cookieCache.delete(domain);
      const freshCookies = await getCookies(domain);
      imageResponse = await fetchImageWithCookies(imageUrl, freshCookies.cookies, freshCookies.userAgent);
    }

    if (!imageResponse.ok) {
      return res.json({
        success: false,
        error: `Image fetch failed: ${imageResponse.status}`
      });
    }

    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';

    if (!contentType.startsWith('image/')) {
      cookieCache.delete(domain);
      return res.json({
        success: false,
        error: 'Received non-image content: ' + contentType
      });
    }

    const buffer = await imageResponse.buffer();
    const base64 = buffer.toString('base64');

    console.log(`[Base64] Success: ${contentType}, ${buffer.length} bytes`);

    return res.json({
      success: true,
      base64,
      contentType,
      size: buffer.length,
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
