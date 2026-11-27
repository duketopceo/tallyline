import type pg from "pg";
import { pool } from "./db/client.js";

export interface HealthReport {
  status: "ok" | "degraded";
  postgres: boolean;
  uptimeSeconds: number;
}

export type HealthQueryable = Pick<pg.Pool, "query">;

export async function checkHealth(
  pgPool: HealthQueryable = pool,
): Promise<HealthReport> {
  const postgres = await pingPostgres(pgPool);
  return {
    status: postgres ? "ok" : "degraded",
    postgres,
    uptimeSeconds: Math.round(process.uptime()),
  };
}

async function pingPostgres(pgPool: HealthQueryable): Promise<boolean> {
  try {
    await pgPool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
