import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { Request, Response } from "express";

const register = new Registry();
collectDefaultMetrics({ register, prefix: "discord_dms_" });

const dmPublishTotal = new Counter({
  name: "discord_dms_publish_total",
  help: "DM events published by the DMS service",
  labelNames: ["event_type"] as const,
  registers: [register],
});

const dmPublishFailuresTotal = new Counter({
  name: "discord_dms_publish_failures_total",
  help: "DM publish path failures by stage",
  labelNames: ["event_type", "stage"] as const,
  registers: [register],
});

const dmPublishDurationMs = new Histogram({
  name: "discord_dms_publish_duration_ms",
  help: "End-to-end time spent publishing a DM event to Redis shards",
  labelNames: ["event_type"] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [register],
});

const dmPendingEnqueueTotal = new Counter({
  name: "discord_dms_pending_enqueue_total",
  help: "Pending DM reconnect hints successfully enqueued",
  registers: [register],
});

const dmPendingEnqueueFailuresTotal = new Counter({
  name: "discord_dms_pending_enqueue_failures_total",
  help: "Pending DM reconnect hint enqueue failures",
  registers: [register],
});

const dmPendingRecipientsTotal = new Counter({
  name: "discord_dms_pending_enqueue_recipients_total",
  help: "Recipient count processed by the pending DM hint queue",
  registers: [register],
});

const dmDirectFanoutTargetsTotal = new Counter({
  name: "discord_dms_direct_fanout_targets_total",
  help: "Realtime instance targets considered for direct DM fanout",
  registers: [register],
});

const dmDirectFanoutRequestsTotal = new Counter({
  name: "discord_dms_direct_fanout_requests_total",
  help: "Direct HTTP fanout requests made to realtime instances, by result",
  labelNames: ["result"] as const,
  registers: [register],
});

const dmDirectFanoutFailuresTotal = new Counter({
  name: "discord_dms_direct_fanout_failures_total",
  help: "Direct HTTP fanout failures by kind",
  labelNames: ["kind"] as const,
  registers: [register],
});

const dmDirectFanoutLatencyMs = new Histogram({
  name: "discord_dms_direct_fanout_latency_ms",
  help: "Latency of individual direct HTTP fanout requests to realtime instances",
  labelNames: ["result"] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
  registers: [register],
});

const dmShardPublishTargetsTotal = new Counter({
  name: "discord_dms_shard_publish_targets_total",
  help: "Per-recipient shard publish targets emitted by DMS",
  registers: [register],
});

export function recordDmPublishStart(eventType: string): void {
  dmPublishTotal.inc({ event_type: eventType });
}

export function recordDmPublishFailure(eventType: string, stage: string): void {
  dmPublishFailuresTotal.inc({ event_type: eventType, stage });
}

export function recordDmPublishDuration(eventType: string, durationMs: number): void {
  dmPublishDurationMs.observe({ event_type: eventType }, durationMs);
}

export function recordPendingEnqueue(participantCount: number): void {
  dmPendingEnqueueTotal.inc();
  dmPendingRecipientsTotal.inc(participantCount);
}

export function recordPendingEnqueueFailure(): void {
  dmPendingEnqueueFailuresTotal.inc();
}

export function recordDirectFanoutTargetCount(targetCount: number): void {
  if (targetCount > 0) dmDirectFanoutTargetsTotal.inc(targetCount);
}

export function recordDirectFanoutRequest(result: "success" | "non_2xx" | "error", latencyMs: number): void {
  dmDirectFanoutRequestsTotal.inc({ result });
  dmDirectFanoutLatencyMs.observe({ result }, latencyMs);
}

export function recordDirectFanoutFailure(kind: "registry_read" | "post_failed" | "non_2xx"): void {
  dmDirectFanoutFailuresTotal.inc({ kind });
}

export function recordShardPublishTargets(count: number): void {
  if (count > 0) dmShardPublishTargetsTotal.inc(count);
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
}
