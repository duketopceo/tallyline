import { afterEach, describe, expect, it } from "vitest";
import { config_ } from "../env.js";
import { app } from "../index.js";
import {
  normalizeRouteLabel,
  recordHttpRequest,
  recordIntakeReport,
  recordWebhookDelivery,
  renderPrometheusMetrics,
  resetMetrics,
  verifyMetricsBearer,
} from "./metrics.js";

const mutable = config_ as unknown as Record<string, unknown>;
const savedToken = config_.metricsBearerToken;

afterEach(() => {
  mutable.metricsBearerToken = savedToken;
  resetMetrics();
});

describe("normalizeRouteLabel", () => {
  it("normalizes secrets, UUIDs, issue keys, and workspace slugs", () => {
    expect(normalizeRouteLabel("/webhooks/glitchtip/secret-abc")).toBe("/webhooks/glitchtip/:token");
    expect(normalizeRouteLabel("/v1/intake/tlintake_abc")).toBe("/v1/intake/:key");
    expect(normalizeRouteLabel("/v1/reporters/tok_123")).toBe("/v1/reporters/:token");
    expect(
      normalizeRouteLabel("/v1/workspaces/acme/issues/550e8400-e29b-41d4-a716-446655440000"),
    ).toBe("/v1/workspaces/:ws/issues/:uuid");
    expect(normalizeRouteLabel("/v1/workspaces/acme/issues/ENG-42")).toBe(
      "/v1/workspaces/:ws/issues/:issueKey",
    );
  });
});

describe("verifyMetricsBearer", () => {
  it("fails closed when expected token is empty or header is wrong", () => {
    expect(verifyMetricsBearer("Bearer secret", "")).toBe(false);
    expect(verifyMetricsBearer(undefined, "secret")).toBe(false);
    expect(verifyMetricsBearer("Basic secret", "secret")).toBe(false);
    expect(verifyMetricsBearer("Bearer wrong", "secret")).toBe(false);
    expect(verifyMetricsBearer("Bearer secret", "secret")).toBe(true);
  });
});

describe("renderPrometheusMetrics", () => {
  it("renders HTTP, DB pool, webhook, and intake metrics in Prometheus text format", () => {
    recordHttpRequest("GET", "/v1/workspaces/acme/issues", 200, 0.042);
    recordWebhookDelivery("github", "accepted");
    recordIntakeReport("public", "created");

    const text = renderPrometheusMetrics({ totalCount: 5, idleCount: 3, waitingCount: 0 });
    expect(text).toContain("tallyline_db_pool_total_connections 5");
    expect(text).toContain("tallyline_db_pool_idle_connections 3");
    expect(text).toContain("tallyline_db_pool_waiting_connections 0");
    expect(text).toContain('http_requests_total{method="GET",route="/v1/workspaces/:ws/issues",status="200"} 1');
    expect(text).toContain('http_request_duration_seconds_count{method="GET",route="/v1/workspaces/:ws/issues"} 1');
    expect(text).toContain('tallyline_webhook_deliveries_total{provider="github",outcome="accepted"} 1');
    expect(text).toContain('tallyline_intake_reports_total{source="public",outcome="created"} 1');
  });
});

describe("GET /metrics endpoint", () => {
  it("returns 404 when METRICS_BEARER_TOKEN is unset", async () => {
    mutable.metricsBearerToken = "";
    const res = await app.fetch(new Request("http://api.test/metrics"));
    expect(res.status).toBe(404);
  });

  it("returns 401 when bearer token is missing or wrong", async () => {
    mutable.metricsBearerToken = "prom-secret-token";
    const missing = await app.fetch(new Request("http://api.test/metrics"));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");

    const wrong = await app.fetch(
      new Request("http://api.test/metrics", {
        headers: { authorization: "Bearer wrong-token" },
      }),
    );
    expect(wrong.status).toBe(401);
  });

  it("returns 200 Prometheus text exposition when bearer token matches", async () => {
    mutable.metricsBearerToken = "prom-secret-token";
    const ping = await app.fetch(new Request("http://api.test/openapi.json"));
    expect(ping.headers.get("x-request-id")).toBeTruthy();

    const res = await app.fetch(
      new Request("http://api.test/metrics", {
        headers: { authorization: "Bearer prom-secret-token" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain; version=0.0.4");
    const body = await res.text();
    expect(body).toContain("tallyline_db_pool_total_connections");
    expect(body).toContain('http_requests_total{method="GET",route="/openapi.json",status="200"} 1');
  });
});
