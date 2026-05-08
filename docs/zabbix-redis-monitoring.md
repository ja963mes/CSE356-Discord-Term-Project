# Zabbix monitoring for the Redis VM

Companion to `ansible/roles/zabbix-agent` and `ansible/inventory/group_vars/redis.yml`. Covers the four `redis-server` instances on **`redis-vm` (10.0.3.49)**: `pubsub:6379`, `pubsub2:6381`, `kv:6380`, `kv2:6382`.

## What ansible already does

- Installs `zabbix-agent2` (Redis plugin built-in).
- Renders `Plugins.Redis.Sessions.<name>.Uri=...` for the four ports (see `zabbix_agent_redis_sessions` in `group_vars/redis.yml`).
- Adds `discord.redis.proc[<port>]` UserParameter for per-port process-liveness.

After `ansible-playbook ... --tags zabbix-agent`, restart the agent and confirm with:

```bash
ssh deploy@10.0.3.49 'zabbix_agent2 -t "redis.info[Server,kv2]" -c /etc/zabbix/zabbix_agent2.conf'
```

## Server-side setup (manual, one-time)

Done in the Zabbix frontend.

### 1. Link the built-in template

Host **`redis-vm`** → *Templates* → link **`Redis by Zabbix agent 2`**. Set host macros:

| Macro | Value |
|-------|-------|
| `{$REDIS.CONN.URI}` | (leave default — overridden per-session below) |
| `{$REDIS.MEM.PUSED.MAX.WARN}` | `80` |
| `{$REDIS.MEM.PUSED.MAX.HIGH}` | `95` |
| `{$REDIS.SLOWLOG.COUNT.MAX.WARN}` | `5` (delta per minute) |
| `{$REDIS.CLIENTS.PRC.MAX.WARN}` | `80` |
| `{$REDIS.REPL.LAG.MAX.WARN}` | `30` (only relevant if replicas added) |

Then **clone the template four times** (or use four host-level template instances) — once per session — and set `{$REDIS.CONN.URI}` to `tcp://127.0.0.1:6379` / `6380` / `6381` / `6382`. The Zabbix template uses the URI to pick the agent2 session by name.

> Easier alternative: keep one host `redis-vm` and add four items per session manually using keys `redis.info[Server,pubsub]`, `redis.info[Stats,kv2]`, etc. Triggers per session.

### 2. Per-session triggers (minimum set)

For each session `S` in `{pubsub, pubsub2, kv, kv2}`:

| Trigger | Expression | Severity |
|---------|------------|----------|
| Process down | `last(/redis-vm/discord.redis.proc[<port>])=0` | **Disaster** |
| Memory > 80% maxmemory | `last(/redis-vm/redis.info[Memory,S].used_memory) / last(/redis-vm/redis.config[maxmemory,S]) > 0.8` | High |
| Memory > 95% (kv/kv2 only — `noeviction` will OOM writes) | same > 0.95 | **Disaster** |
| Slowlog growth | `change(/redis-vm/redis.slowlog.count[S]) > 5` per minute | Warning |
| Rejected connections growing | `change(/redis-vm/redis.info[Clients,S].rejected_connections) > 0` | High |
| Blocked clients | `min(/redis-vm/redis.info[Clients,S].blocked_clients,1m) > 0` | Warning |
| Connected clients spike | `last(/redis-vm/redis.info[Clients,S].connected_clients) > 1000` | Warning |
| Ops anomaly | `last(/redis-vm/redis.info[Stats,S].instantaneous_ops_per_sec) > 3 * avg(...,1h)` | Info |

### 3. VM-level (host already in Zabbix via Linux-by-agent2 template)

| Trigger | Expression | Severity |
|---------|------------|----------|
| CPU user > 80% / 5m | `min(/redis-vm/system.cpu.util[,user],5m) > 80` | High |
| CPU user > 95% / 2m | `min(/redis-vm/system.cpu.util[,user],2m) > 95` | Disaster |
| Load avg5 per CPU > 1.5 | `last(/redis-vm/system.cpu.load[percpu,avg5]) > 1.5` | High |
| Memory > 85% | `last(/redis-vm/vm.memory.utilization) > 85` | High |

> Per-port CPU isolation: the VM has 8 cores but each `redis-server` is single-threaded. A hot instance will sit at ~12.5% of `system.cpu.util` even while saturated. Trust the per-session triggers (slowlog, blocked, rejected, ops) over aggregate VM CPU for redis-specific saturation.

### 4. Notification action

*Configuration → Actions → Trigger actions* → new action:

- **Conditions:** trigger severity ≥ High AND host group = `redis`.
- **Operations:** notify the on-call media (Slack webhook / email / etc.). Recovery + update steps mirror the operation.

## Post-deploy validation

```bash
# On redis-vm:
sudo systemctl status zabbix-agent2
sudo zabbix_agent2 -t "redis.info[Server,kv]"   # should print INFO Server JSON
sudo zabbix_agent2 -t "discord.redis.proc[6382]" # should print 1
```

In Zabbix server: *Monitoring → Latest data → host: redis-vm* should show `redis.*` items going green within ~120s of agent restart.

## Future: replicas / cluster

When replicas are added, link `Redis Replication` items per session and add `{$REDIS.REPL.LAG.MAX.WARN}` triggers — agent2 picks them up automatically once `INFO Replication` returns role=master with non-empty `slave0`.
