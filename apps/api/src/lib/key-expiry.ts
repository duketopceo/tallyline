import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const days = z.coerce.number().int().min(0).max(3650);

/**
 * AGENT_KEY_DEFAULT_EXPIRY_DAYS: unset means 90; 0 means no default expiry.
 * Anything else that is not an integer 0-3650 fails startup instead of
 * silently becoming NaN (which would mint non-expiring keys).
 */
export function parseKeyExpiryDays(raw: string | undefined): number {
  if (raw === undefined) return 90;
  const s = nonEmpty.safeParse(raw);
  const r = s.success ? days.safeParse(s.data) : s;
  if (!r.success) {
    throw new Error(
      `AGENT_KEY_DEFAULT_EXPIRY_DAYS must be an integer from 0 to 3650, got ${JSON.stringify(raw)}`,
    );
  }
  return r.data;
}
