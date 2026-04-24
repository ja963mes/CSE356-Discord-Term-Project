import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { Request, Response } from "express";

type RealtimeStateSnapshot = {
  connections: number;
  users: number;
  totalQueuedMessages: number;
  maxQueueDepth: number;
};

const register = new Registry();
collectDefaultMetrics({ register, prefix: "discord_realtime_" });

let stateGetter: () => RealtimeStateSnapshot = () => ({
  connections: 0,
  users: 0,
  totalQueuedMessages: 0,
  maxQueueDepth: 0,
});

export function setRealtimeStateGetter(getter: () => RealtimeStateSnapshot): void {
  stateGetter = getter;
}

const activeConnectionsGauge = new Gauge({
  name: "discord_realtime_active_connections",
  help: "Active websocket connections tracked by this realtime worker",
  registers: [register],
  collect() {
    this.set(stateGetter().connections);
  },
});

const activeUsersGauge = new Gauge({
  name: "discord_realtime_active_local_users",
  help: "Distinct local users with at least one websocket connection on this worker",
  registers: [register],
  collect() {
    this.set(stateGetter().users);
  },
});

const totalQueuedMessagesGauge = new Gauge({
  name: "discord_realtime_total_queued_messages",
  help: "Total outbound websocket messages currently queued on this worker",
  registers: [register],
  collect() {
    this.set(stateGetter().totalQueuedMessages);
  },
});

const maxQueueDepthGauge = new Gauge({
  name: "discord_realtime_max_queue_depth",
  help: "Largest outbound websocket queue depth currently observed on this worker",
  registers: [register],
  collect() {
    this.set(stateGetter().maxQueueDepth);
  },
});

const wsEvictionsCounter = new Counter({
  name: "discord_realtime_ws_evictions_total",
  help: "Websocket connections evicted or removed from local maps",
  labelNames: ["reason"] as const,
  registers: [register],
});

const wsNotOpenDropsCounter = new Counter({
  name: "discord_realtime_ws_not_open_drops_total",
  help: "Delivery attempts dropped because the websocket was not OPEN",
  labelNames: ["label"] as const,
  registers: [register],
});

const wsImportantQueueKillsCounter = new Counter({
  name: "discord_realtime_ws_important_queue_kills_total",
  help: "Connections killed because their important-message queue exceeded the configured cap",
  registers: [register],
});

const wsBackpressureKillsCounter = new Counter({
  name: "discord_realtime_ws_backpressure_kills_total",
  help: "Connections killed due to websocket bufferedAmount backpressure",
  registers: [register],
});

const wsSendFailuresCounter = new Counter({
  name: "discord_realtime_ws_send_failures_total",
  help: "Websocket send failures while flushing outbound queues",
  registers: [register],
});

const dmDeliveryAttemptsCounter = new Counter({
  name: "discord_realtime_dm_delivery_attempts_total",
  help: "DM delivery attempts seen by realtime, by source",
  labelNames: ["source"] as const,
  registers: [register],
});

const dmDeliveryEnqueuedCounter = new Counter({
  name: "discord_realtime_dm_delivery_enqueued_total",
  help: "DM deliveries enqueued to local websocket connections",
  labelNames: ["source"] as const,
  registers: [register],
});

const dmDeliveryLocalMissCounter = new Counter({
  name: "discord_realtime_dm_delivery_local_miss_total",
  help: "DM delivery attempts that found no local recipient connection on this worker",
  labelNames: ["source"] as const,
  registers: [register],
});

const dmRecoveryCounter = new Counter({
  name: "discord_realtime_dm_recovery_total",
  help: "DM deliveries recovered after reconnect via pending queue or catch-up",
  labelNames: ["source"] as const,
  registers: [register],
});

const dmRecoveryLatencyMs = new Histogram({
  name: "discord_realtime_dm_recovery_latency_ms",
  help: "Latency from DMS publish to recovered DM delivery on reconnect",
  labelNames: ["source"] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
  registers: [register],
});

const dmLiveDeliveryLatencyMs = new Histogram({
  name: "discord_realtime_dm_live_delivery_latency_ms",
  help: "Latency from DMS publish to live DM send enqueue on this worker",
  labelNames: ["source"] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [register],
});

const dmCatchupDurationMs = new Histogram({
  name: "discord_realtime_dm_catchup_duration_ms",
  help: "Duration of Cassandra-backed DM catch-up replays",
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
  registers: [register],
});

const dmCatchupReplayCount = new Histogram({
  name: "discord_realtime_dm_catchup_replayed_messages",
  help: "Number of messages replayed by a single DM catch-up pass",
  buckets: [0, 1, 2, 5, 10, 25, 50, 100, 250],
  registers: [register],
});

void activeConnectionsGauge;
void activeUsersGauge;
void totalQueuedMessagesGauge;
void maxQueueDepthGauge;

export function recordWsEviction(reason: string): void {
  wsEvictionsCounter.inc({ reason });
  if (reason === "backpressure_kill") wsBackpressureKillsCounter.inc();
  if (reason === "send_failed") wsSendFailuresCounter.inc();
  if (reason === "important_queue_full") wsImportantQueueKillsCounter.inc();
}

export function recordWsNotOpenDrop(label: string): void {
  wsNotOpenDropsCounter.inc({ label });
}

export function recordDmDeliveryAttempt(source: string, targets = 1): void {
  dmDeliveryAttemptsCounter.inc({ source }, targets);
}

export function recordDmDeliveryEnqueued(source: string, count = 1): void {
  dmDeliveryEnqueuedCounter.inc({ source }, count);
}

export function recordDmDeliveryLocalMiss(source: string, count = 1): void {
  dmDeliveryLocalMissCounter.inc({ source }, count);
}

export function recordDmLiveDeliveryLatency(source: string, latencyMs?: number): void {
  if (latencyMs === undefined || Number.isNaN(latencyMs) || latencyMs < 0) return;
  dmLiveDeliveryLatencyMs.observe({ source }, latencyMs);
}

export function recordDmRecovery(source: string, latencyMs?: number): void {
  dmRecoveryCounter.inc({ source });
  if (latencyMs === undefined || Number.isNaN(latencyMs) || latencyMs < 0) return;
  dmRecoveryLatencyMs.observe({ source }, latencyMs);
}

export function recordDmCatchup(durationMs: number, replayedCount: number): void {
  dmCatchupDurationMs.observe(durationMs);
  dmCatchupReplayCount.observe(replayedCount);
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
}
