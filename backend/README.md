# QR Master Pro — Secure Link Expiry & Remote Image Deletion Gateway

This backend service powers authoritative server-enforced link expiry and authenticated remote image deletion from Cloudinary for QR Master Pro.

---

## 1. Why a Backend Gateway is Essential

1. **Secret Credential Isolation**:
   - Cloudinary requires an `API_SECRET` to execute image deletions (`/v1_1/<cloud_name>/image/destroy`).
   - Storing API secrets in client-side HTML, JavaScript, or Android APKs is a critical security vulnerability that allows anyone to inspect your code, steal your credentials, and delete or hijack all your cloud assets.
   - The backend keeps `CLOUDINARY_API_SECRET` strictly on the server.

2. **Authoritative Expiry Enforcement**:
   - Setting an expiry date in a mobile browser's `localStorage` or SQLite database **does not** stop a public Cloudinary URL (`https://res.cloudinary.com/...`) from continuing to serve the image.
   - The Gateway creates a protected routing URL (`/api/view/:assetId`) that is encoded into the QR code.
   - When a person scans the QR code, the gateway server verifies whether `Date.now() > expiresAt`. If expired, it responds with an HTTP 410 Gone page, strictly denying access.
   - If active, it seamlessly redirects the user to the image.

3. **Tamper-Proof Deletion Tokens**:
   - When an image is uploaded, the server generates a cryptographically random 48-character hexadecimal `deleteToken`.
   - Only the creator receives this token.
   - Any remote deletion request (`DELETE /api/assets/:assetId`) or expiry modification (`POST /api/assets/:assetId/expiry`) requires this token in the `X-Delete-Token` header.
   - This prevents malicious users from guessing asset IDs and deleting other people's images.

---

## 2. Setup & Configuration

### Prerequisites
- Node.js 18.0 or higher.
- A free or paid Cloudinary account (https://cloudinary.com).

### Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Configure your values:
```env
PORT=3000
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
BASE_URL=https://your-backend-domain.com
```

### Running Locally
```bash
node server.js
```

Or for Android Emulator testing:
- Set `BASE_URL=http://10.0.2.2:3000` (since `10.0.2.2` is Android's loopback to the host machine).
- In the QR Master Pro app settings, enter `http://10.0.2.2:3000` under **Backend Gateway URL**.

---

## 3. Production Deployment Options

### Option A: Render (Free & Fast)
1. Push this repository to GitHub.
2. In Render Dashboard, click **New Web Service**.
3. Set **Root Directory** to `backend`.
4. Build Command: `node --version`
5. Start Command: `node server.js`
6. Add your Environment Variables (`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `BASE_URL`).

### Option B: Railway / Cloud Run
1. Deploy `server.js` with port 3000 or `$PORT`.
2. Set environment variables in the project settings.
3. Use the generated HTTPS domain in the mobile app settings.

---

## 4. API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health status and Cloudinary credential verification. |
| `POST` | `/api/upload` | Uploads an image, creates asset record, and returns `assetId`, `deleteToken`, and `gatewayUrl`. |
| `GET` | `/api/view/:assetId` | The gateway link encoded in the QR code. Verifies expiry before redirecting. |
| `POST` | `/api/assets/:assetId/expiry` | Updates expiry duration (requires `X-Delete-Token`). |
| `DELETE` | `/api/assets/:assetId` | Deletes image from Cloudinary and marks link unavailable (requires `X-Delete-Token`). |
| `GET` | `/api/assets/:assetId/status` | Returns current authoritative status, time remaining, and server time. |
