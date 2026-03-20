# Auth Service

Authentication service for the Discord clone project (CSE 356). Handles local signup/login and OAuth (Google, GitHub, course OIDC).

## Prerequisites

- **Node.js** v18+
- **PostgreSQL** running on `localhost:5432`
- **Redis** running on `localhost:6379`
- **Docker** (easiest way to run Postgres and Redis)

## Quick Start

### 1. Start Postgres and Redis

If you have Docker:

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

### 4. Run database migrations

```bash
npm run db:migrate
```

### 5. Start the dev server

```bash
npm run dev
```

The app will be running at **http://localhost:3001**.

- Login/Register page: http://localhost:3001/login.html
- Landing page (requires auth): http://localhost:3001/

## Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with auto-reload (nodemon + ts-node) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled app from `dist/` |
| `npm run db:generate` | Generate a new migration from schema changes |
| `npm run db:migrate` | Apply pending migrations to the database |

## Project Structure

```
src/
  index.ts              # Express app entry point
  config/
    env.ts              # Environment variable validation (Zod)
    oauth.ts            # OAuth/OIDC provider configuration
  db/
    index.ts            # Drizzle ORM + pg pool
    redis.ts            # Redis connection (ioredis)
    schema.ts           # Database schema (users, identities)
  middleware/
    session.ts          # requireAuth middleware
  routes/
    auth.ts             # All auth routes (register, login, OAuth)
  types/
    express.d.ts        # Express Request type augmentation
public/
  login.html            # Sign up / Sign in page
  home.html             # Post-login landing page
drizzle/
  *.sql                 # Generated migration files
```

## Troubleshooting

- **Redis connection errors** — Make sure Redis is running: `docker ps` or `redis-cli ping`
- **Database migration fails** — Make sure Postgres is running and `auth_db` exists: `docker exec postgres-auth psql -U postgres -c "SELECT 1"`
- **Port already in use** — Change `PORT` in `.env` or kill the existing process