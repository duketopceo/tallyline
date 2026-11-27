import { timingSafeEqual } from "node:crypto";

// Lightweight Prometheus text exposition (0.0.4) registry — zero extra runtime
// dependencies, low-cardinality normalized route labels, and live DB pool stats.

export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

export interface PoolStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

/**
 * Normalize a request pathname into a low-cardinality route label.
 * Redacts all secret/token path segments and dynamic IDs so Prometheus
 * cardinality stays bounded and credentials never appear in metrics.
 */
export function normalizeRouteLabel(pathname: string): string {
  const clean = pathname.split("?")[0] ?? "/";
  if (/^\/webhooks\/glitchtip\/[^/]+/i.test(clean)) return "/webhooks/glitchtip/:token";
  if (/^\/v1\/intake\/[^/]+/i.test(clean)) return "/v1/intake/:key";
  if (/^\/v1\/reports?\/[^/]+/i.test(clean)) return "/v1/report/:token";
  if (/^\/v1\/reporters\/[^/]+/i.test(clean)) return "/v1/reporters/:token";

  const segments = clean.split("/").map((seg, idx, arr) => {
    if (!seg) return "";
    if (UUID_RE.test(seg)) return ":uuid";
    if (NUMERIC_RE.test(seg)) return ":id";
    if (ISSUE_KEY_RE.test(seg)) return ":issueKey";
    // workspace slug immediately follows /workspaces/
    if (idx > 0 && arr[idx - 1] === "workspaces") return ":ws";
    // oauth provider segment
    if (idx > 1 && arr[idx - 1] === "oauth" && arr[idx - 2] === "auth") return ":provider";
    return seg;
  });
  return segments.join("/") || "/";
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}`;
}

interface HistogramSample {
  buckets: number[];
  sum: number;
  count: number;
  method: string;
  route: string;
}

const httpRequests = new Map<string, { method: string; route: string; status: string; value: number }>();
const httpDurations = new Map<string, HistogramSample>();
const webhookDeliveries = new Map<string, { provider: string; outcome: string; value: number }>();
const intakeReports = new Map<string, { source: string; outcome: string; value: number }>();

export function recordHttpRequest(
  method: string,
  pathname: string,
  status: number,
  durationSeconds: number,
): void {
  const m = method.toUpperCase();
  const route = normalizeRouteLabel(pathname);
  const s = String(status);

  const reqKey = `${m}\0${route}\0${s}`;
  const existing = httpRequests.get(reqKey);
  if (existing) {
    existing.value += 1;
  } else {
    httpRequests.set(reqKey, { method: m, route, status: s, value: 1 });
  }

  const durKey = `${m}\0${route}`;
  let hist = httpDurations.get(durKey);
  if (!hist) {
    hist = {
      buckets: new Array<number>(DURATION_BUCKETS.length).fill(0),
      sum: 0,
      count: 0,
      method: m,
      route,
    };
    httpDurations.set(durKey, hist);
  }
  const safeDuration = Number.isFinite(durationSeconds) && durationSeconds >= 0 ? durationSeconds : 0;
  for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
    if (safeDuration <= DURATION_BUCKETS[i]!) {
      hist.buckets[i] = (hist.buckets[i] ?? 0) + 1;
    }
  }
  hist.sum += safeDuration;
  hist.count += 1;
}

export function recordWebhookDelivery(
  provider: "github" | "slack" | "glitchtip" | "sentry",
  outcome: "accepted" | "duplicate" | "rejected" | "error",
): void {
  const key = `${provider}\0${outcome}`;
  const existing = webhookDeliveries.get(key);
  if (existing) {
    existing.value += 1;
  } else {
    webhookDeliveries.set(key, { provider, outcome, value: 1 });
  }
}

export function recordIntakeReport(
  source: "public" | "authenticated",
  outcome: "created" | "deduped" | "duplicate_delivery" | "rejected",
): void {
  const key = `${source}\0${outcome}`;
  const existing = intakeReports.get(key);
  if (existing) {
    existing.value += 1;
  } else {
    intakeReports.set(key, { source, outcome, value: 1 });
  }
}

export function resetMetrics(): void {
  httpRequests.clear();
  httpDurations.clear();
  webhookDeliveries.clear();
  intakeReports.clear();
}

/** Constant-time check for `Authorization: Bearer <token>`. */
export function verifyMetricsBearer(authHeader: string | undefined, expectedToken: string): boolean {
  if (!expectedToken || !authHeader) return false;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  const provided = authHeader.slice(prefix.length);
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expectedToken, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function renderPrometheusMetrics(poolStats: PoolStats): string {
  const lines: string[] = [];

  lines.push("# HELP process_uptime_seconds Process uptime in seconds.");
  lines.push("# TYPE process_uptime_seconds gauge");
  lines.push(`process_uptime_seconds ${Math.round(process.uptime())}`);

  lines.push("# HELP tallyline_db_pool_total_connections Total clients in the PostgreSQL connection pool.");
  lines.push("# TYPE tallyline_db_pool_total_connections gauge");
  lines.push(`tallyline_db_pool_total_connections ${poolStats.totalCount}`);

  lines.push("# HELP tallyline_db_pool_idle_connections Idle clients in the PostgreSQL connection pool.");
  lines.push("# TYPE tallyline_db_pool_idle_connections gauge");
  lines.push(`tallyline_db_pool_idle_connections ${poolStats.idleCount}`);

  lines.push("# HELP tallyline_db_pool_waiting_connections Queued requests waiting for a PostgreSQL connection.");
  lines.push("# TYPE tallyline_db_pool_waiting_connections gauge");
  lines.push(`tallyline_db_pool_waiting_connections ${poolStats.waitingCount}`);

  lines.push("# HELP http_requests_total Total HTTP requests handled by the API.");
  lines.push("# TYPE http_requests_total counter");
  for (const item of httpRequests.values()) {
    lines.push(
      `http_requests_total${formatLabels({ method: item.method, route: item.route, status: item.status })} ${item.value}`,
    );
  }

  lines.push("# HELP http_request_duration_seconds HTTP request duration in seconds.");
  lines.push("# TYPE http_request_duration_seconds histogram");
  for (const hist of httpDurations.values()) {
    for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
      lines.push(
        `http_request_duration_seconds_bucket${formatLabels({ method: hist.method, route: hist.route, le: String(DURATION_BUCKETS[i]) })} ${hist.buckets[i]}`,
      );
    }
    lines.push(
      `http_request_duration_seconds_bucket${formatLabels({ method: hist.method, route: hist.route, le: "+Inf" })} ${hist.count}`,
    );
    lines.push(
      `http_request_duration_seconds_sum${formatLabels({ method: hist.method, route: hist.route })} ${hist.sum}`,
    );
    lines.push(
      `http_request_duration_seconds_count${formatLabels({ method: hist.method, route: hist.route })} ${hist.count}`,
    );
  }

  lines.push("# HELP tallyline_webhook_deliveries_total Inbound webhook deliveries by provider and outcome.");
  lines.push("# TYPE tallyline_webhook_deliveries_total counter");
  for (const item of webhookDeliveries.values()) {
    lines.push(
      `tallyline_webhook_deliveries_total${formatLabels({ provider: item.provider, outcome: item.outcome })} ${item.value}`,
    );
  }

  lines.push("# HELP tallyline_intake_reports_total Intake reports processed by source and outcome.");
  lines.push("# TYPE tallyline_intake_reports_total counter");
  for (const item of intakeReports.values()) {
    lines.push(
      `tallyline_intake_reports_total${formatLabels({ source: item.source, outcome: item.outcome })} ${item.value}`,
    );
  }

  return `${lines.join("\n")}\n`;
}
