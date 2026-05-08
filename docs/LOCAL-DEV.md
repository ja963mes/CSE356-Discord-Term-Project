# Running a Service Locally Against Staging

Run one (or more) services on your machine while everything else hits the live staging VM. No Docker required.

## Prerequisites

- Node.js installed
- `sshuttle` installed (`pip install sshuttle` or `brew install sshuttle` on Mac)
- SSH access to the staging VM (`root@130.245.136.45`) — make sure your key is added

## Step 1 — Open the tunnel

In a dedicated terminal, keep this running the whole time:

```bash
sshuttle -r root@130.245.136.45 10.0.0.0/8
```

This routes all `10.0.0.x` traffic (Redis, Postgres, Cassandra, MinIO) through the staging VM over SSH. You'll know it's working when it says `c : Connected`.

## Step 2 — Start your service locally

Open a new terminal and run the service you're working on:

```bash
npm run dev:auth:staging
npm run dev:communities:staging
npm run dev:messages:staging
npm run dev:search:staging
npm run dev:realtime:staging
npm run dev:dms:staging
npm run dev:read-state:staging
```

The `:staging` suffix loads `.env.staging-infra` so your local service connects to the real staging Redis/Postgres/Cassandra instead of a local instance.

## Step 3 — Start the frontend

In another terminal:

```bash
npm run dev:frontend:staging:local
```

This starts Vite on `localhost:5173` and proxies all API calls to `localhost:<port>` — so your locally running service gets the traffic, and the staging VM handles everything else.

Open `http://localhost:5173` in your browser.

## Quick reference — ports

| Service       | Port |
|---------------|------|
| auth          | 3001 |
| communities   | 3002 |
| messages      | 3003 |
| search        | 3004 |
| realtime      | 3005 |
| dms           | 3007 |
| read-state    | 3008 |
| frontend      | 5173 |

## Tips

- **Logs:** your local service logs print straight to the terminal. Set `LOG_LEVEL=debug` for more detail:
  ```bash
  LOG_LEVEL=debug npm run dev:dms:staging
  ```
- **Tunnel drops:** if requests start failing, check the `sshuttle` terminal — reconnect if needed.
- **Multiple services at once:** just repeat Step 2 in separate terminals for each service you want local.
- **Only frontend:** skip Steps 1–2 and just run `npm run dev:frontend:staging` to point the browser straight at the live staging VM (no local services).
