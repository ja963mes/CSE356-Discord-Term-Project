# Zabbix (local dev)

This repo includes an **optional Zabbix profile** in [`docker-compose.yml`](../docker-compose.yml) for local monitoring experiments. It does **not** change the default dev flow; you only start it when you want it.

## Start

```bash
docker compose --profile monitoring up -d
```

Services started by the profile:

- `zabbix-postgres`
- `zabbix-server`
- `zabbix-web`
- `zabbix-agent`

Default local URLs / ports:

- Zabbix UI: `http://localhost:8081`
- Zabbix server: `localhost:10051`
- Zabbix agent: `localhost:10050`
- Zabbix Postgres: `localhost:5434`

Default first-login credentials:

- username: `Admin`
- password: `zabbix`

## Stop

```bash
docker compose --profile monitoring down
```

To remove the monitoring data volumes too:

```bash
docker compose --profile monitoring down -v
```

## Environment knobs

See [`.env.example`](../.env.example) for the optional Zabbix variables:

- `ZABBIX_WEB_PORT`
- `ZABBIX_SERVER_PORT`
- `ZABBIX_AGENT_PORT`
- `ZABBIX_POSTGRES_PORT`
- `ZABBIX_DB_NAME`
- `ZABBIX_DB_USER`
- `ZABBIX_DB_PASSWORD`
- `ZABBIX_AGENT_HOSTNAME`
- `ZABBIX_TIMEZONE`

## What this profile is for

This profile gives you a place to:

- monitor the local Docker dependencies
- add HTTP health checks for the host-run Node services
- experiment with dashboards, triggers, and availability checks before wiring monitoring into staging/prod

## Deploy agents to the VMs with Ansible

This repo also includes an optional Ansible role that installs **Zabbix agent 2** on every managed VM.

Files involved:

- [`ansible/roles/zabbix-agent/`](../ansible/roles/zabbix-agent)
- [`ansible/playbooks/site.yml`](../ansible/playbooks/site.yml)
- [`ansible/inventory/group_vars/all.yml`](../ansible/inventory/group_vars/all.yml)

### 1. Set the Zabbix server host

In `ansible/inventory/group_vars/all.yml`:

```yaml
manage_zabbix_agent: true
zabbix_agent_server: "YOUR_ZABBIX_SERVER_IP_OR_DNS"
```

Optional:

```yaml
zabbix_agent_server_active: "YOUR_ZABBIX_SERVER_IP_OR_DNS"
```

### 2. Run the Ansible playbook

From `ansible/`:

```bash
ansible-playbook -i inventory/hosts.ini playbooks/site.yml
```

This installs:

- the official Zabbix repository package
- `zabbix-agent2`
- `/etc/zabbix/zabbix_agent2.conf`
- Discord-specific user parameters:
  - `discord.service.active[*]`
  - `discord.health[*]`

### 3. Useful keys on the Zabbix server

Examples after agent rollout:

- `discord.service.active[discord-realtime]`
- `discord.service.active[discord-dms]`
- `discord.health[http://127.0.0.1:3005/health]`
- `discord.health[http://127.0.0.1:3007/health]`

Those give you a fast way to create items/triggers for service health without writing custom scripts on each VM.

Because the application services normally run on the **host** with `npm run dev:all`, Zabbix should target `host.docker.internal` for host-based checks from inside the monitoring containers.

Useful starter checks:

- `http://host.docker.internal:3001/health` — auth
- `http://host.docker.internal:3002/health` — communities
- `http://host.docker.internal:3003/health` — messages
- `http://host.docker.internal:3004/health` — search
- `http://host.docker.internal:3005/health` — realtime
- `http://host.docker.internal:3007/health` — dms

If you later merge app-level `/metrics` endpoints, you can add HTTP agent checks or external scripts against those too.

## Recommended first host in Zabbix

Create one host named something like `discord-local-dev` and attach:

- the Zabbix agent interface at `zabbix-agent:10050`
- web scenarios / HTTP agent items against `host.docker.internal`

Suggested first triggers:

- service health endpoint not `200`
- Zabbix agent unreachable
- Redis/Postgres container unavailable
- high response time on `realtime` / `dms`

## Notes

- `host.docker.internal` is added explicitly through `extra_hosts` so Linux Docker can resolve it via `host-gateway`.
- The Zabbix profile uses its **own Postgres database** so it does not interfere with the app database.
- The profile is aimed at **local/staging experimentation**, not a production Zabbix deployment layout.
