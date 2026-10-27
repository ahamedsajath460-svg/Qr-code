/**
 * QR Master Pro — Secure Link Expiry & Remote Image Deletion Gateway
 * 
 * Provides:
 * 1. POST /api/upload: Uploads image to Cloudinary securely using server-side secrets,
 *    creates an asset record with an authorized deleteToken and server-enforced expiry.
 * 2. GET /api/view/:assetId: Gateway redirect route that authoritatively verifies
 *    expiry against server time before allowing access to the image.
 * 3. POST /api/assets/:assetId/expiry: Updates link expiry timestamp (requires deleteToken).
 * 4. DELETE /api/assets/:assetId: Deletes asset from Cloudinary via Admin/Upload API
 *    (requires deleteToken to prevent unauthorized or arbitrary asset deletion).
 * 5. GET /api/assets/:assetId/status: Returns authoritative server status & expiry.
 * 6. GET /api/health: Health check.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Environment & Configuration
const PORT = process.env.PORT || 3000;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '';
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || '';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// In-Memory Database with optional JSON file persistence
const DB_FILE = path.join(__dirname, 'assets-db.json');
let assetStore = {};

function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      assetStore = JSON.parse(data);
    }
  } catch (err) {
    console.warn('[DB] Could not load assets-db.json, starting fresh:', err.message);
  }
}

function saveDatabase() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(assetStore, null, 2), 'utf8');
  } catch (err) {
    console.warn('[DB] Could not save assets-db.json:', err.message);
  }
}

loadDatabase();

// CORS Headers
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Delete-Token');
}

// JSON Response Helper
function sendJson(res, statusCode, data) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Error Helper
function sendError(res, statusCode, message, code = 'ERROR') {
  sendJson(res, statusCode, {
    success: false,
    error: {
      code,
      message,
      serverTime: new Date().toISOString()
    }
  });
}

// Parse JSON Body
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 25 * 1024 * 1024) { // 25MB limit
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

// Cloudinary Remote API Destroyer
function deleteFromCloudinary(publicId) {
  return new Promise((resolve, reject) => {
    if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
      return reject(new Error('Cloudinary credentials (CLOUD_NAME, API_KEY, API_SECRET) are not configured on the backend.'));
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const toSign = `public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
    const signature = crypto.createHash('sha1').update(toSign).digest('hex');

    const postData = new URLSearchParams({
      public_id: publicId,
      api_key: CLOUDINARY_API_KEY,
      timestamp: timestamp.toString(),
      signature: signature
    }).toString();

    const options = {
      hostname: 'api.cloudinary.com',
      port: 443,
      path: `/v1_1/${CLOUDINARY_CLOUD_NAME}/image/destroy`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.result === 'ok' || parsed.result === 'not found') {
            resolve({ success: true, result: parsed.result });
          } else {
            reject(new Error(`Cloudinary error: ${parsed.result || parsed.error?.message || 'Unknown error'}`));
          }
        } catch (err) {
          reject(new Error('Invalid response from Cloudinary'));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.write(postData);
    req.end();
  });
}

// Direct Cloudinary Upload from Server
function uploadToCloudinary(fileBase64, filename) {
  return new Promise((resolve, reject) => {
    if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
      return reject(new Error('Cloudinary credentials are not configured on server.'));
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const toSign = `timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
    const signature = crypto.createHash('sha1').update(toSign).digest('hex');

    const postData = new URLSearchParams({
      file: fileBase64,
      api_key: CLOUDINARY_API_KEY,
      timestamp: timestamp.toString(),
      signature: signature,
      folder: 'QRMasterPro'
    }).toString();

    const options = {
      hostname: 'api.cloudinary.com',
      port: 443,
      path: `/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.secure_url) {
            resolve({
              url: parsed.secure_url,
              publicId: parsed.public_id,
              bytes: parsed.bytes,
              format: parsed.format
            });
          } else {
            reject(new Error(parsed.error?.message || 'Cloudinary upload failed'));
          }
        } catch (err) {
          reject(new Error('Invalid response from Cloudinary during upload'));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.write(postData);
    req.end();
  });
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // Handle CORS Preflight
  if (method === 'OPTIONS') {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // 1. Health Check
    if (pathname === '/api/health' && method === 'GET') {
      return sendJson(res, 200, {
        status: 'ok',
        service: 'QR Master Pro Gateway',
        provider: 'Cloudinary',
        isCloudinaryConfigured: Boolean(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET),
        serverTime: new Date().toISOString()
      });
    }

    // 2. Gateway Image Access View Route (Authoritative Link Expiry Check)
    if (pathname.startsWith('/api/view/') && method === 'GET') {
      const assetId = pathname.replace('/api/view/', '').trim();
      const asset = assetStore[assetId];

      if (!asset) {
        setCorsHeaders(res);
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Image Not Found — QR Master Pro</title>
            <style>
              body { font-family: -apple-system, sans-serif; background: #F4F6F9; color: #111827; text-align: center; padding: 3rem 1.5rem; }
              .card { max-width: 420px; margin: 0 auto; background: white; padding: 2.5rem; border-radius: 20px; box-shadow: 0 4px 16px rgba(0,0,0,0.06); }
              .icon { font-size: 3rem; margin-bottom: 1rem; }
              h1 { font-size: 1.3rem; margin-bottom: 0.5rem; color: #EF4444; }
              p { color: #6B7280; font-size: 0.95rem; line-height: 1.5; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="icon">🔍</div>
              <h1>Image Not Found</h1>
              <p>The requested QR image does not exist or may have been removed.</p>
            </div>
          </body>
          </html>
        `);
      }

      // Check if Deleted
      if (asset.status === 'deleted') {
        setCorsHeaders(res);
        res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Image Deleted — QR Master Pro</title>
            <style>
              body { font-family: -apple-system, sans-serif; background: #F4F6F9; color: #111827; text-align: center; padding: 3rem 1.5rem; }
              .card { max-width: 420px; margin: 0 auto; background: white; padding: 2.5rem; border-radius: 20px; box-shadow: 0 4px 16px rgba(0,0,0,0.06); }
              .icon { font-size: 3rem; margin-bottom: 1rem; }
              h1 { font-size: 1.3rem; margin-bottom: 0.5rem; color: #EF4444; }
              p { color: #6B7280; font-size: 0.95rem; line-height: 1.5; }
              .meta { font-size: 0.8rem; color: #9CA3AF; margin-top: 1.5rem; border-top: 1px solid #E5E7EB; padding-top: 1rem; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="icon">🗑️</div>
              <h1>Image Removed</h1>
              <p>This image has been permanently deleted from remote cloud storage by its owner.</p>
              <div class="meta">Asset ID: ${assetId} • Deleted on: ${new Date(asset.deletedAt || Date.now()).toLocaleDateString()}</div>
            </div>
          </body>
          </html>
        `);
      }

      // Authoritative Expiry Check against Server Time
      const now = Date.now();
      if (asset.expiresAt && now > asset.expiresAt) {
        asset.status = 'expired';
        saveDatabase();

        setCorsHeaders(res);
        res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Link Expired — QR Master Pro</title>
            <style>
              body { font-family: -apple-system, sans-serif; background: #F4F6F9; color: #111827; text-align: center; padding: 3rem 1.5rem; }
              .card { max-width: 420px; margin: 0 auto; background: white; padding: 2.5rem; border-radius: 20px; box-shadow: 0 4px 16px rgba(0,0,0,0.06); }
              .icon { font-size: 3rem; margin-bottom: 1rem; }
              h1 { font-size: 1.3rem; margin-bottom: 0.5rem; color: #F59E0B; }
              p { color: #6B7280; font-size: 0.95rem; line-height: 1.5; }
              .badge { display: inline-block; background: #FEF3C7; color: #B45309; padding: 4px 12px; border-radius: 999px; font-weight: 700; font-size: 0.8rem; margin: 1rem 0; }
              .meta { font-size: 0.8rem; color: #9CA3AF; margin-top: 1.5rem; border-top: 1px solid #E5E7EB; padding-top: 1rem; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="icon">⏰</div>
              <h1>QR Link Expired</h1>
              <div class="badge">Access Closed</div>
              <p>This image QR code link expired on <strong>${new Date(asset.expiresAt).toLocaleString()}</strong> as scheduled by the creator.</p>
              <div class="meta">Enforced by QR Master Pro Secure Gateway</div>
            </div>
          </body>
          </html>
        `);
      }

      // Active & Valid: Redirect to actual hosted image
      setCorsHeaders(res);
      res.writeHead(302, { 'Location': asset.providerUrl || asset.imageUrl });
      return res.end();
    }

    // 3. Register or Upload an Asset
    // POST /api/upload
    if (pathname === '/api/upload' && method === 'POST') {
      const body = await parseJsonBody(req);
      const { fileBase64, filename, expiresAt, directUrl, publicId } = body;

      const assetId = 'ast_' + crypto.randomBytes(8).toString('hex');
      const deleteToken = crypto.randomBytes(24).toString('hex'); // Secret authorization token
      const createdAt = Date.now();

      let finalUrl = directUrl;
      let finalPublicId = publicId || assetId;

      // If base64 file is sent and Cloudinary is configured on server:
      if (fileBase64 && CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
        try {
          const uploadRes = await uploadToCloudinary(fileBase64, filename || assetId);
          finalUrl = uploadRes.url;
          finalPublicId = uploadRes.publicId;
        } catch (uploadErr) {
          return sendError(res, 502, `Cloudinary upload failed: ${uploadErr.message}`, 'UPLOAD_FAILED');
        }
      }

      if (!finalUrl) {
        return sendError(res, 400, 'Either fileBase64 or directUrl must be provided.', 'INVALID_PARAMETERS');
      }

      const gatewayUrl = `${BASE_URL}/api/view/${assetId}`;

      const assetRecord = {
        assetId,
        deleteToken,
        filename: filename || 'image.jpg',
        providerUrl: finalUrl,
        gatewayUrl,
        publicId: finalPublicId,
        provider: 'Cloudinary',
        createdAt,
        expiresAt: expiresAt ? Number(expiresAt) : null,
        status: 'active'
      };

      assetStore[assetId] = assetRecord;
      saveDatabase();

      return sendJson(res, 201, {
        success: true,
        assetId,
        deleteToken, // Given ONLY to the uploader so only they can delete/update it
        gatewayUrl,
        providerUrl: finalUrl,
        publicId: finalPublicId,
        expiresAt: assetRecord.expiresAt,
        status: 'active',
        createdAt
      });
    }

    // 4. Update Expiry Date/Time
    // POST /api/assets/:assetId/expiry
    if (pathname.startsWith('/api/assets/') && pathname.endsWith('/expiry') && method === 'POST') {
      const parts = pathname.split('/');
      const assetId = parts[3];
      const asset = assetStore[assetId];

      if (!asset) {
        return sendError(res, 404, 'Asset not found', 'ASSET_NOT_FOUND');
      }

      const body = await parseJsonBody(req);
      const authHeader = req.headers['x-delete-token'] || body.deleteToken;

      // Authorization verification
      if (!authHeader || authHeader !== asset.deleteToken) {
        return sendError(res, 403, 'Unauthorized: Invalid delete/management token for this asset.', 'UNAUTHORIZED');
      }

      if (asset.status === 'deleted') {
        return sendError(res, 400, 'Cannot change expiry for an already deleted asset.', 'ASSET_DELETED');
      }

      const { expiresAt } = body;
      const newExpiry = expiresAt ? Number(expiresAt) : null;

      if (newExpiry && newExpiry <= Date.now()) {
        return sendError(res, 400, 'Expiry date must be in the future.', 'INVALID_EXPIRY');
      }

      asset.expiresAt = newExpiry;
      if (asset.status === 'expired' && (!newExpiry || newExpiry > Date.now())) {
        asset.status = 'active';
      }
      saveDatabase();

      return sendJson(res, 200, {
        success: true,
        assetId,
        expiresAt: asset.expiresAt,
        status: asset.status,
        message: 'Expiry policy successfully updated.'
      });
    }

    // 5. Authoritative Remote Asset Deletion
    // DELETE /api/assets/:assetId
    if (pathname.startsWith('/api/assets/') && method === 'DELETE') {
      const parts = pathname.split('/');
      const assetId = parts[3];
      const asset = assetStore[assetId];

      if (!asset) {
        return sendError(res, 404, 'Asset not found', 'ASSET_NOT_FOUND');
      }

      // Check Token from Header or query
      const token = req.headers['x-delete-token'] || parsedUrl.query.deleteToken;
      if (!token || token !== asset.deleteToken) {
        return sendError(res, 403, 'Unauthorized: Valid management token required to delete this asset.', 'UNAUTHORIZED');
      }

      // If already deleted, idempotent response
      if (asset.status === 'deleted') {
        return sendJson(res, 200, {
          success: true,
          assetId,
          status: 'deleted',
          message: 'Asset was already deleted from remote storage.'
        });
      }

      // Delete from Cloudinary if publicId exists and backend has credentials
      let providerResult = 'local_record_only';
      if (asset.publicId && CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
        try {
          const destroyRes = await deleteFromCloudinary(asset.publicId);
          providerResult = destroyRes.result || 'ok';
        } catch (err) {
          console.error('[Cloudinary Deletion Error]', err.message);
          return sendError(res, 502, `Failed to delete from Cloudinary: ${err.message}`, 'PROVIDER_DELETION_FAILED');
        }
      }

      asset.status = 'deleted';
      asset.deletedAt = Date.now();
      saveDatabase();

      return sendJson(res, 200, {
        success: true,
        assetId,
        status: 'deleted',
        providerResult,
        message: 'Asset successfully removed from remote cloud hosting. QR code will now report image deleted.'
      });
    }

    // 6. Asset Status & Server Time Authority
    // GET /api/assets/:assetId/status
    if (pathname.startsWith('/api/assets/') && pathname.endsWith('/status') && method === 'GET') {
      const parts = pathname.split('/');
      const assetId = parts[3];
      const asset = assetStore[assetId];

      if (!asset) {
        return sendError(res, 404, 'Asset not found', 'ASSET_NOT_FOUND');
      }

      const now = Date.now();
      const isExpired = Boolean(asset.expiresAt && now > asset.expiresAt);
      const currentStatus = asset.status === 'deleted' ? 'deleted' : (isExpired ? 'expired' : 'active');

      return sendJson(res, 200, {
        success: true,
        assetId,
        filename: asset.filename,
        provider: asset.provider,
        publicId: asset.publicId,
        status: currentStatus,
        createdAt: asset.createdAt,
        expiresAt: asset.expiresAt,
        serverTime: now,
        timeRemainingMs: asset.expiresAt ? Math.max(0, asset.expiresAt - now) : null,
        gatewayUrl: asset.gatewayUrl,
        providerUrl: asset.providerUrl
      });
    }

    // 404 Not Found
    return sendError(res, 404, `Route ${method} ${pathname} not found`, 'NOT_FOUND');

  } catch (err) {
    console.error('[Unhandled Server Error]', err);
    return sendError(res, 500, `Internal server error: ${err.message}`, 'SERVER_ERROR');
  }
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 QR Master Pro Gateway listening on port ${PORT}`);
  console.log(`🌐 Base URL: ${BASE_URL}`);
  console.log(`☁️ Cloudinary Configured: ${Boolean(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET)}`);
  console.log(`=======================================================`);
});
