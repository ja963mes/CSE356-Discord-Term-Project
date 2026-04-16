# Production nginx (split frontend + backend VMs)

**Supported** nginx baselines for production (and the pattern staging should mirror when using two roles). Index of all docs: **[README.md](./README.md)**.

This guide is for a **two-VM** topology:

- **Frontend VM**: serves static `frontend/dist` and terminates TLS for the public domain.
- **Backend VM**: runs Node services and nginx that proxies service paths to local ports.

Example hosts:

- Frontend VM: `130.245.136.115`
- Backend VM: `130.245.136.45`
- Public domain: `group-6.cse356.compas.cs.stonybrook.edu`

---

## 1) Topology and request flow

Client traffic should go to the frontend VM only:

1. Browser hits `https://group-6.cse356.compas.cs.stonybrook.edu` -> frontend VM nginx.
2. Frontend VM serves static SPA from `/var/www/discord-frontend`.
3. API and WS routes are proxied by frontend VM nginx to backend VM nginx (`http://130.245.136.45:80`).
4. Backend VM nginx proxies to local Node services (`127.0.0.1:3001..3008`).

This avoids exposing all backend service ports publicly.

---

## 2) DNS and certificate

1. Set the A record for `group-6.cse356.compas.cs.stonybrook.edu` to `130.245.136.115`.
2. Verify propagation:
   - `dig +short group-6.cse356.compas.cs.stonybrook.edu`
   - `dig @1.1.1.1 +short group-6.cse356.compas.cs.stonybrook.edu`
3. On frontend VM, issue cert:
   - `sudo certbot --nginx -d group-6.cse356.compas.cs.stonybrook.edu`

If cert issuance fails and error shows `130.245.136.45`, DNS is still pointed at the backend VM.

---

## 3) Frontend VM setup

### 3.1 Build + publish static assets

```bash
cd ~/CSE356-Discord-Term-Project
npm ci
npm run build --workspace frontend

sudo mkdir -p /var/www/discord-frontend
sudo rsync -a --delete ~/CSE356-Discord-Term-Project/frontend/dist/ /var/www/discord-frontend/
sudo chown -R root:www-data /var/www/discord-frontend
sudo chmod -R g+rX /var/www/discord-frontend
```

Verify:

```bash
ls -la /var/www/discord-frontend/index.html
```

### 3.2 Nginx responsibilities on frontend VM

- Must serve static SPA:
  - `root /var/www/discord-frontend;`
  - `location / { try_files ... @spa; }`
- Must proxy these prefixes to backend VM nginx (`http://130.245.136.45:80`):
  - `/auth`
  - `/create-community`
  - `/communities`
  - `/channels`
  - `/messages`
  - `/attachments`
  - `/search-communities`
  - `/search` (if enabled)
  - `/dms`
  - `/read-state`
  - `/ws`

Use [`nginx-linode-production-frontend.conf.example`](./nginx-linode-production-frontend.conf.example) as your baseline.

Use a single upstream for consistency:

```nginx
upstream backend_api {
    server 130.245.136.45:80;
    keepalive 64;
}
```

And route all API/WS prefixes via `proxy_pass http://backend_api;`.

### 3.3 Recommended proxy timeouts

On API locations:

```nginx
proxy_connect_timeout 3s;
proxy_read_timeout 30s;
proxy_send_timeout 30s;
```

On `/ws`:

```nginx
proxy_read_timeout 86400;
proxy_connect_timeout 3s;
```

### 3.4 Validate frontend VM nginx

```bash
sudo nginx -t
sudo systemctl reload nginx
curl -I https://group-6.cse356.compas.cs.stonybrook.edu
curl -I https://group-6.cse356.compas.cs.stonybrook.edu/assets/index-*.js
```

---

## 4) Backend VM setup

### 4.1 Keep backend services running

Run and monitor:

- `discord-auth` (3001)
- `discord-communities` (3002)
- `discord-create-community` (3006)
- `discord-messages` (3003)
- `discord-realtime` (3005)
- `discord-dms` (3007)
- `discord-read-state` (3008)

### 4.2 Nginx responsibilities on backend VM

Backend VM nginx should be API/WS only and proxy local service ports.

Use [`nginx-linode-production-backend.conf.example`](./nginx-linode-production-backend.conf.example) as baseline.

Do not rely on frontend static serving on backend VM.

### 4.3 Backend environment

On backend VM, set:

- `FRONTEND_URL=https://group-6.cse356.compas.cs.stonybrook.edu`
- OAuth callbacks:
  - `https://group-6.cse356.compas.cs.stonybrook.edu/auth/google/callback`
  - `https://group-6.cse356.compas.cs.stonybrook.edu/auth/github/callback`
  - `https://group-6.cse356.compas.cs.stonybrook.edu/auth/oidc/callback`

Restart auth service after changes.

---

## 5) Common failure modes

### 5.1 Blank page but HTML returns 200

Usually static assets are missing from `/var/www/discord-frontend` or static block is commented.

### 5.2 `upstream timed out while connecting to upstream`

Usually frontend VM is proxying to unreachable backend service ports. Prefer frontend VM -> backend VM nginx `:80` instead of frontend VM -> backend VM `:300x` directly.

### 5.3 Missing communities/DMs after migration

Usually mixed routing (some paths to one backend target, others to another). Ensure all API prefixes use the same backend target.

### 5.4 Certbot unauthorized points to backend IP

DNS still points to backend VM, not frontend VM.

---

## 6) Post-cutover checks

From browser/devtools:

- App loads over HTTPS.
- `/auth/me` succeeds (or fast 401 if not logged in).
- `/ws` upgrades successfully.
- Channel and DM data load from expected environment.

From frontend VM logs:

- No sustained `upstream timed out` in `/var/log/nginx/error.log`.

---

## 7) Deprecated nginx examples (do not use for new installs)

These files remain in `docs/` for historical reference only; each file begins with a **DEPRECATED** banner:

- `nginx-linode-staging.conf.example` — old single-host “full staging” proxy
- `nginx-linode-production.conf.example` — old single-host “static + API” combined production
- `nginx-linode-services-only.conf.example` — old partial-stack proxy

**Use only** `nginx-linode-production-frontend.conf.example` and `nginx-linode-production-backend.conf.example` for new deployments. For a single machine, merge `location` blocks from both (same path order as `frontend/vite.config.ts`) or run API nginx + Vite elsewhere.

