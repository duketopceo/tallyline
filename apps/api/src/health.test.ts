import { describe, expect, it, vi } from "vitest";
import { checkHealth, type HealthQueryable } from "./health.js";

describe("checkHealth", () => {
  it("reuses the provided shared pg pool and reports ok when SELECT 1 succeeds", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] });
    const fakePool = { query } as unknown as HealthQueryable;

    const first = await checkHealth(fakePool);
    const second = await checkHealth(fakePool);

    expect(first.status).toBe("ok");
    expect(first.postgres).toBe(true);
    expect(second.status).toBe("ok");
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith("SELECT 1");
  });

  it("reports degraded when SELECT 1 rejects", async () => {
    const query = vi.fn().mockRejectedValue(new Error("connection refused"));
    const fakePool = { query } as unknown as HealthQueryable;

    const report = await checkHealth(fakePool);
    expect(report.status).toBe("degraded");
    expect(report.postgres).toBe(false);
  });
});
