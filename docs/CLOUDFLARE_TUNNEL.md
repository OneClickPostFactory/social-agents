# Cloudflare Tunnel Setup

This project can be exposed through Cloudflare Tunnel without changing the backend code.

## Recommended setup

For your current single-tenant product shape, the best path is:

- frontend on `oneclickwebsitefactory.tailwaggingwebdesign.com`
- backend on `api.oneclickwebsitefactory.tailwaggingwebdesign.com`
- Cloudflare Tunnel publishing the backend hostname to `http://localhost:4001`

If your frontend is also local, you can publish both frontend and backend through the same tunnel using different hostnames.

## Why this is the recommended path

Cloudflare’s current docs say:

- Quick tunnels are for testing only and generate a random `trycloudflare.com` subdomain.
- Quick tunnels have a `200` concurrent request limit and do not support Server-Sent Events.
- For production, create a real tunnel and publish a hostname through Cloudflare.
- Cloudflare recommends remotely-managed tunnels for most use cases.

Official sources:

- Cloudflare Tunnel overview: https://developers.cloudflare.com/tunnel/
- Cloudflare Tunnel setup: https://developers.cloudflare.com/tunnel/setup/
- Tunnel configuration file: https://developers.cloudflare.com/tunnel/advanced/local-management/configuration-file/
- Locally-managed tunnel guidance: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/

## Backend env for a separate frontend

For your current frontend on `https://oneclickwebsitefactory.tailwaggingwebdesign.com`, use:

```env
FRONTEND_BASE_URL=https://oneclickwebsitefactory.tailwaggingwebdesign.com
APP_ALLOWED_ORIGINS=https://oneclickwebsitefactory.tailwaggingwebdesign.com
COOKIE_SECURE=true
COOKIE_SAME_SITE=Lax
GUI_PORT=4001
```

Notes:

- `FRONTEND_BASE_URL` is used for Stripe success/cancel URLs.
- `APP_ALLOWED_ORIGINS` must include the exact frontend origin.
- `COOKIE_SECURE=true` is required once you are serving over HTTPS.
- `COOKIE_SAME_SITE=Lax` is the cleanest choice when frontend and backend live on subdomains of the same site.

If your frontend stays on a completely different site, you will usually need:

```env
COOKIE_SECURE=true
COOKIE_SAME_SITE=None
```

That allows credentialed cross-origin requests, but same-site subdomains are still the better production setup.

## Frontend requirements

Your frontend requests should:

- call the backend using the API hostname
- send credentials on authenticated requests
- store and resend the CSRF token returned by bootstrap/login or `/api/auth/me`

In browser fetch terms:

```ts
await fetch("https://api.example.com/api/auth/me", {
  credentials: "include",
});
```

For mutating authenticated routes:

```ts
await fetch("https://api.example.com/api/settings/runtime", {
  method: "PUT",
  credentials: "include",
  headers: {
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken,
  },
  body: JSON.stringify(payload),
});
```

## Option A: quick tunnel for demo only

Use this only for short-lived testing:

```bash
cloudflared tunnel --url http://localhost:4001
```

Then set:

```env
APP_ALLOWED_ORIGINS=https://your-frontend-preview-domain
FRONTEND_BASE_URL=https://your-frontend-preview-domain
COOKIE_SECURE=true
COOKIE_SAME_SITE=None
```

This is fine for demos, but not the right production shape.

## Option B: real tunnel for production

### 1. Create a tunnel in Cloudflare

Create a tunnel in the Cloudflare dashboard and get the install/run command or token.

### 2. Publish hostnames

Map:

- `api.example.com` -> `http://localhost:4001`
- optionally `app.example.com` -> your frontend local port

### 3. Run the tunnel

If using a token-based remotely-managed tunnel, Cloudflare’s documented run pattern is:

```bash
cloudflared service install <TUNNEL_TOKEN>
```

If using a local config file, an example file is included at:

- `cloudflared/config.example.yml`

### 4. Point frontend to the backend

Set your frontend API base URL to:

```text
https://api.oneclickwebsitefactory.tailwaggingwebdesign.com
```

## Recommended product decision

Given where your project is right now:

- use Cloudflare Tunnel first if you want the fastest path to a working internet-accessible backend
- move the backend to a stable cloud VM next if this machine is not intended to stay up 24/7

The backend is already structured for that move:

- fixed port
- auth and billing control plane
- origin allowlist
- Stripe return URL configuration

So Cloudflare Tunnel is the right short-term bridge, and a cloud VM is the better steady-state home.
