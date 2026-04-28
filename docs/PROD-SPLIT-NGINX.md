# Production nginx (split frontend + backend + auth VMs)

**Supported** nginx baselines for production (and the pattern staging should mirror when using two roles). Index of all docs: **[README.md](./README.md)**.

This guide is for a **three-VM edge/API topology** (plus optional dedicated search ingress and dedicated realtime VM):

- **Frontend VM**: serves static `frontend/dist` and terminates TLS for the public domain.
- **Auth VM**: runs `auth-service` and serves `/auth` directly on private network (`:3001`).
- **Backend VM**: runs non-auth Node services and nginx that proxies service paths to local ports.
- **Optional Search ingress VM/host**: dedicated nginx for `search-service` (`/search`, `/directory`) with scalable upstream pool.

Example hosts:

- Frontend VM: `130.245.136.115`
- Auth VM: `130.245.136.131` (Private IP: `10.0.3.158`)
- Backend VM: `130.245.136.45` (Private IP: `10.0.2.247`)
- Search VM: `130.245.136.135` (Private IP: `10.0.2.26`)
- Public domain: `group-6.cse356.compas.cs.stonybrook.edu`

---

## 1) Topology and request flow

Client traffic should go to the frontend VM only:

1. Browser hits `https://group-6.cse356.compas.cs.stonybrook.edu` -> frontend VM nginx.
2. Frontend VM serves static SPA from `/var/www/discord-frontend`.
3. Frontend VM nginx proxies `/auth` directly to auth-service on the auth VM over private network (`http://10.0.3.158:3001`).
4. Remaining API and WS routes are proxied by frontend VM nginx to backend VM nginx over private network (`http://10.0.2.247:80`).
5. Backend VM nginx proxies non-auth APIs to localhost (`127.0.0.1:3002,3003,3007,3008`); `/ws` is proxied to the realtime VM on the private network (see `nginx/production-backend.conf.example`, `upstream backend_realtime`).
6. Optional: frontend `/search` can target dedicated search ingress instead of backend nginx.

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
- Must proxy `/auth` directly to auth-service on auth VM private network (`http://10.0.3.158:3001`).
- Must proxy these prefixes to backend VM nginx over private network (`http://10.0.2.247:80`):
  - `/create-community`
  - `/communities`
  - `/channels`
  - `/messages`
  - `/attachments`
  - `/search-communities`
  - `/dms`
  - `/read-state`
  - `/ws`
- Proxy `/search` to dedicated search ingress (`nginx/production-search.conf.example`) when search is split out.

Use [`nginx/production-frontend.conf.example`](./nginx/production-frontend.conf.example) as your baseline.

Use dedicated upstreams for auth and backend:

```nginx
upstream auth_api {
    server 10.0.3.158:3001;
    keepalive 32;
}

upstream backend_api {
    server 10.0.2.247:80;
    keepalive 64;
}
```

Route `/auth` via `proxy_pass http://auth_api;` and all other API/WS prefixes via `proxy_pass http://backend_api;`.

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

Run and monitor on **this** backend VM:

- `discord-communities` (3002, also handles `POST /create-community`)
- `discord-messages` (3003)
- `discord-dms` (3007)
- `discord-read-state` (3008)

When realtime is split onto a **realtime VM**, run `discord-realtime` / `discord-realtime-2` there (3005 / 3009) and point nginx `upstream backend_realtime` at that host’s private IP.

### 4.2 Nginx responsibilities on backend VM

Backend VM nginx should be API/WS only: proxy API paths to localhost Node ports, and `/ws` to the realtime upstream (localhost or private IP per `production-backend.conf.example`).

Use [`nginx/production-backend.conf.example`](./nginx/production-backend.conf.example) as baseline.
This backend config intentionally excludes `/search`; use dedicated search ingress for that route.

Do not rely on frontend static serving on backend VM.

### 4.3 Backend environment

On backend VM, set:

- `FRONTEND_URL=https://group-6.cse356.compas.cs.stonybrook.edu`

Backend no longer runs `discord-auth`.

### 4.4 Auth VM environment

On auth VM, set:

- `FRONTEND_URL=https://group-6.cse356.compas.cs.stonybrook.edu`
- OAuth callbacks:
  - `https://group-6.cse356.compas.cs.stonybrook.edu/auth/google/callback`
  - `https://group-6.cse356.compas.cs.stonybrook.edu/auth/github/callback`
  - `https://group-6.cse356.compas.cs.stonybrook.edu/auth/oidc/callback`

Restart `discord-auth` after changes.

---

## 5) Common failure modes

### 5.1 Blank page but HTML returns 200

Usually static assets are missing from `/var/www/discord-frontend` or static block is commented.

### 5.2 `upstream timed out while connecting to upstream`

Usually frontend VM is proxying to unreachable private upstreams. Verify:

- `/auth` -> auth VM `10.0.3.158:3001`
- other API + `/ws` -> backend VM nginx `10.0.2.247:80`

### 5.3 Missing communities/DMs after migration

Usually mixed routing (for example, `/auth` target correct but non-auth paths pointing to wrong host). Ensure route split matches `production-frontend.conf.example`.

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

- `nginx/deprecated/linode-staging.conf.example` — old single-host “full staging” proxy
- `nginx/deprecated/linode-production-combined.conf.example` — old single-host “static + API” combined production
- `nginx/deprecated/linode-services-only.conf.example` — old partial-stack proxy

**Use only** `nginx/production-frontend.conf.example`, `nginx/production-backend.conf.example`, and (when split out) `nginx/production-search.conf.example` for new deployments. For a single machine, merge `location` blocks from the needed configs (same path order as `frontend/vite.config.ts`) or run API nginx + Vite elsewhere.

