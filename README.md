# Discord Clone (CSE 356) — Monorepo

Monorepo containing multiple backend services plus a React frontend. The primary backend service in this repo is the authentication service (Express) with session auth backed by Redis and PostgreSQL.

Implementation scope and how this compares to the full architecture (nginx, Cassandra messages, Elasticsearch, DMs over WebSockets/SSE, etc.) is documented in **[IMPLEMENTATION.md](./IMPLEMENTATION.md)**.

## Prerequisites

- **Node.js** v18+
- **PostgreSQL** running (often `localhost:5433` with this repo's `docker-compose.yml`, or `5432` if you run Postgres directly)
- **Redis** running on `localhost:6379`
- **Docker** (easiest way to run Postgres and Redis)

## Quick Start

### 1. Start Postgres and Redis

If you have Docker Compose (recommended):

```bash
docker compose up -d
```

This starts Postgres on host **5433** and Redis on **6379**.

If you do not want Docker Compose and instead run Postgres/Redis directly, use the options below.

If you have Docker (no compose):

```bash
# PostgreSQL
docker run -d --name postgres-auth -p 5432:5432 -e POSTGRES_PASSWORD=123456789 -e POSTGRES_DB=auth_db postgres:16-alpine

# Redis
docker run -d --name redis-auth -p 6379:6379 redis:7-alpine
```

If you already have Postgres/Redis installed locally, just make sure they're running.

### 2. Install dependencies

```bash
npm install
```

### 3. Set up environment variables

Get the `.env` file from a team member and place it in the project root.
Make sure `DATABASE_URL` matches how Postgres is running:

- Docker Compose default: `localhost:5433`
- Docker run / local Postgres default: `localhost:5432`

### 4. Run database migrations

```bash
npm run db:migrate
```

### 5. Start services

Start the auth service (required for login):

```bash
npm run dev:auth
```

Start the React frontend:

```bash
npm run dev:frontend
```

The frontend will be running at **http://localhost:5173**.

- Login (wireframe UI): http://localhost:5173/login
- Chat (wireframe UI): http://localhost:5173/

Optional stub services for the wireframes:

- `npm run dev:communities` (port 3002)
- `npm run dev:messages` (port 3003)
- `npm run dev:search` (port 3004)
- `npm run dev:realtime` (port 3005)

Note: the frontend includes fallback sample data, so it can render even if some stub services are not running.

## Available Scripts

| Command | Description |
|---|---|
| `npm run dev:all` | Start auth + stubs + frontend in parallel |
| `npm run dev` | Start React frontend (port 5173) |
| `npm run dev:auth` | Start authentication service (port 3001) |
| `npm run dev:frontend` | Start React frontend (port 5173) |
| `npm run dev:communities` | Start communities stub service (port 3002) |
| `npm run dev:messages` | Start messages stub service (port 3003) |
| `npm run dev:search` | Start search stub service (port 3004) |
| `npm run dev:realtime` | Start realtime stub service (port 3005) |
| `npm run db:generate` | Generate a new migration (auth service) |
| `npm run db:migrate` | Apply pending migrations (auth service) |

## Project Structure

```
services/
  auth/
    src/
    public/
    drizzle/
  communities/
  messages/
  search/
  realtime/
frontend/
  src/
```

## Troubleshooting

- **Redis connection errors** — Make sure Redis is running: `docker ps` or `redis-cli ping`
- **Database migration fails** — Make sure Postgres is running and `auth_db` exists:
  - Docker Compose: `docker exec discord-clone-postgres psql -U postgres -d auth_db -c "SELECT 1"`
  - Docker run: `docker exec postgres-auth psql -U postgres -d auth_db -c "SELECT 1"`
- **Port already in use** — Change `PORT` in `.env` or kill the existing process (auth defaults to 3001)