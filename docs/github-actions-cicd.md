# GitHub Actions CI/CD — main application server

This document describes how to integrate **GitHub Actions** so that pushes (or merges) to GitHub automatically **test, build, and deploy** the application stack to your **main server** (the host that runs Node services, nginx, etc.).  

**Out of scope here:** the **Cassandra cluster VMs** — they do not run this repo’s app; treat them as a separate infrastructure concern (see [STAGING-ROLLOUT.md](./STAGING-ROLLOUT.md) and [sharding-and-replication.md](./sharding-and-replication.md)).

---

## 1. Goals

| Goal | Typical approach |
|------|------------------|
| Run tests / lint on every PR | Job runs on `pull_request` |
| Deploy only when merged to `main` / `main-dev` | Job runs on `push` to those branches, or on `workflow_dispatch` for manual deploy |
| Deploy artifacts to **one** main server | SSH + `git pull` or `rsync` built assets + `systemctl restart …` |
| Keep secrets out of the repo | GitHub **Secrets** (and optional **Environments** with protection rules) |

---

## 2. Prerequisites on the main server

Before Actions can deploy, the server should be able to run the stack the same way you do manually (see [STAGING-ROLLOUT.md](./STAGING-ROLLOUT.md)):

- **Node.js** (LTS, matches local dev)
- **Git** clone of this repo at a fixed path (e.g. `/opt/CSE356-Discord-Term-Project` or `$HOME/CSE356-Discord-Term-Project`)
- **systemd** units for each service (e.g. `discord-auth`, `discord-dms`, …) or a single orchestration pattern you document
- **Environment file** not committed to Git (e.g. `/etc/discord-staging.env`) referenced by systemd `EnvironmentFile=`
- **SSH access** for deploy:
  - Dedicated **deploy user** (recommended) with permission to `git pull`, run `npm ci` / `npm run build`, and `sudo systemctl restart …` (often via a **limited sudoers** rule)
- **Repo ownership:** the deploy user must own the clone (or the workflow runs `sudo chown -R deploy:deploy "$DEPLOY_PATH"` before `npm ci`). If anyone ran **`sudo npm install`** in the repo, `node_modules` becomes root-owned and **`npm ci` fails with `EACCES` / unlink `.bin/...`**. Fix once on the server: `sudo chown -R deploy:deploy /path/to/CSE356-Discord-Term-Project` (use your real user and path). The staging workflow runs **`sudo chown -R "$(whoami):$(whoami)" .`** in `DEPLOY_PATH`; grant passwordless sudo for that `chown` on that tree, or rely on correct ownership without sudo.
- **Optional:** `DATABASE_URL_DIRECT` set so **migrations** can run against Postgres without going through PgBouncer (see root `.env.example`)

---

## 3. GitHub configuration

### 3.1 Secrets (repository or environment)

Store these in **Settings → Secrets and variables → Actions**:

| Secret | Purpose |
|--------|---------|
| `SSH_PRIVATE_KEY` | Private key for the deploy user (PEM, full multiline key) |
| `SSH_HOST` | Main server hostname or IP |
| `SSH_USER` | SSH login (e.g. `deploy`) |
| `SSH_KNOWN_HOSTS` | Output of `ssh-keyscan -H your.host` (prevents MITM; optional but recommended) |

Optional, depending on your script:

| Secret | Purpose |
|--------|---------|
| `DEPLOY_PATH` | Absolute path to the repo on the server |

Use **Environments** (e.g. `production`, `staging`) if you want **approval gates** or different secrets per stage.

### 3.2 Branch protection (recommended)

- Require PR checks (tests) before merge to `main` / `main-dev`
- Restrict who can push to default branches

---

## 4. What the workflow should do (high level)

A minimal, safe pipeline has **two stages**:

### Stage A — CI (on every PR and/or every push)

Runs on GitHub-hosted runners (Ubuntu):

1. Checkout code  
2. `npm ci` at repo root (workspaces)  
3. Run tests / lint you care about, e.g.  
   - `npm run build --workspace frontend`  
   - service-level tests if dependencies are available in CI (often Postgres/Cassandra/Redis are **not** available; you may scope tests or use services/containers — keep this realistic for your team)

If Stage A fails, **do not deploy**.

### Stage B — Deploy (only on success, only for allowed branches)

Runs **after** Stage A on `push` to `main` / `main-dev` (or only on `workflow_dispatch`):

1. **Connect to main server over SSH** using the secrets above  
2. On the server, either:  
   - **Git-based:** `cd DEPLOY_PATH && git fetch && git checkout <ref> && git pull`, then `npm ci`, `npm run build` (frontend and any build steps), then `npm run db:migrate` if DB is reachable from that host, then `sudo systemctl restart …`  
   - **Artifact-based:** build in Actions, `rsync`/`scp` `dist/` and lockfile to server, then install prod deps and restart (more complex; often unnecessary for a single VM)

Exact commands should match your [STAGING-ROLLOUT.md](./STAGING-ROLLOUT.md) manual procedure so deploy is “automation of what you already do.”

---

## 5. Example workflow shape (reference)

You will add a file under `.github/workflows/` (e.g. `deploy-main.yml`). Below is a **structural** outline only — adjust names, branches, and commands to match your systemd units and paths.

```yaml
name: CI and deploy main server

on:
  push:
    branches: [main-dev, main]
  pull_request:
    branches: [main-dev, main]
  workflow_dispatch:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"
      - run: npm ci
      - run: npm run build --workspace frontend
      # Add more checks as needed

  deploy:
    needs: ci
    if: github.event_name == 'push' && (github.ref == 'refs/heads/main-dev' || github.ref == 'refs/heads/main')
    runs-on: ubuntu-latest
    environment: production   # optional: requires approval if configured
    steps:
      - name: Deploy over SSH
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script_stop: true
          script: |
            set -e
            cd /path/to/CSE356-Discord-Term-Project
            git fetch origin
            git checkout "${{ github.sha }}" || git checkout ${{ github.ref_name }} && git pull
            npm ci
            npm run build --workspace frontend
            npm run db:migrate
            sudo systemctl restart discord-auth discord-dms discord-messages discord-realtime discord-communities
            sudo systemctl reload nginx
```

**Notes:**

- Checking out **`${{ github.sha }}`** is good for reproducibility; ensure the server’s clone has fetched that commit (e.g. `git fetch origin ${{ github.sha }}` then `git checkout ${{ github.sha }}`).
- **systemd unit names** must match your server ([STAGING-ROLLOUT.md](./STAGING-ROLLOUT.md) lists examples like `discord-dms.service`).
- **`npm run db:migrate`** requires Postgres reachable from the main server with `DATABASE_URL` / `DATABASE_URL_DIRECT` set for the **auth** workspace migrate (see repo root `package.json`).

---

## 6. Security checklist

- Never commit private keys or `.env` files  
- Use a **deploy-only** SSH key; rotate if leaked  
- Prefer **command-restricted** SSH or a small **deploy script** on the server instead of a full login shell  
- Limit `sudo` in sudoers to the exact `systemctl`/`nginx`/`chown` (on the deploy tree only) commands needed  
- Use **GitHub Environment protection** for production deploys (required reviewers)

---

## 7. Troubleshooting

| Symptom | Things to verify |
|---------|-------------------|
| SSH fails from Actions | Key format, user, host firewall allowing GitHub IPs (or use self-hosted runner in same network) |
| `npm ci` fails on server | Node version, disk space, lockfile committed |
| `npm ci` **EACCES** / `unlink node_modules/.bin/...` | **Root-owned `node_modules`** (e.g. past `sudo npm install`). Run `sudo chown -R deploy:deploy "$DEPLOY_PATH"` once; ensure deploy can run `sudo chown` on that path if the workflow uses it, or never use `sudo` with npm in the repo |
| App old after deploy | Wrong branch/ref, deploy path, or services not restarted |
| DB errors after deploy | Migrations not run, or `DATABASE_URL` points at PgBouncer for migrate — use `DATABASE_URL_DIRECT` for Drizzle |

---

## 8. Related docs

- [STAGING-ROLLOUT.md](./STAGING-ROLLOUT.md) — manual staging steps, systemd, nginx  
- [branching.md](./branching.md) — branch workflow (`nick` → `main-dev`)  
- Root `.env.example` — `DATABASE_URL`, `DATABASE_URL_DIRECT`, ports  

---

## 9. Optional extensions

- **Slack / email** notifications on failure (Actions step or third-party app)  
- **Smoke test** after deploy: `curl` health endpoints  
- **Separate workflow** for Cassandra/infrastructure changes (Ansible, manual approval), not on every app push  

This keeps **application CI/CD** focused on the **main server** while cluster operations stay deliberate and safe.
