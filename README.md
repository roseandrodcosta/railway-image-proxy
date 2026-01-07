# Railway Image Proxy

A lightweight proxy service that fetches images from Cloudflare-protected sites using FlareSolverr.

## Why This Exists

Cloudflare's `cf_clearance` cookies are IP-bound. When FlareSolverr solves a challenge:
- The cookies only work from the IP that solved the challenge (Railway)
- If you try to use those cookies from Vercel, they won't work

This proxy runs on Railway alongside FlareSolverr, so it shares the same outbound IP.

## Endpoints

### GET /image?url=<encoded-url>
Returns the image binary with proper Content-Type headers.

### GET /image/base64?url=<encoded-url>
Returns JSON with base64-encoded image data:
```json
{
  "success": true,
  "base64": "...",
  "contentType": "image/jpeg",
  "size": 123456
}
```

### GET /health
Health check endpoint.

## Environment Variables

- `PORT` - Server port (default: 3000)
- `FLARESOLVERR_URL` - FlareSolverr endpoint (default: http://localhost:8191/v1)

## Deployment

Deploy to the same Railway project as FlareSolverr:

1. Create a new service in your Railway project
2. Connect to this GitHub repo (or deploy via CLI)
3. Set `FLARESOLVERR_URL` to the internal FlareSolverr URL

## Usage from Vercel/Other Services

```javascript
const proxyUrl = 'https://your-railway-proxy.up.railway.app';
const imageUrl = 'https://static.flexdog.com/path/to/image.jpg';

// Get image binary
const response = await fetch(`${proxyUrl}/image?url=${encodeURIComponent(imageUrl)}`);
const imageBlob = await response.blob();

// Get base64 for Cloudinary upload
const response = await fetch(`${proxyUrl}/image/base64?url=${encodeURIComponent(imageUrl)}`);
const { success, base64, contentType } = await response.json();
```
