import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface ApiError {
  error: { code: string; message: string };
}

// The machine-readable code of the last refusal on this request. The access
// log reads it, so a 401 can be told apart from a 401 for the wrong reason
// (expired credential vs. wrong audience vs. unverified email) without a
// second trip to the database.
declare module "hono" {
  interface ContextVariableMap {
    errorCode?: string;
  }
}

export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
) {
  c.set("errorCode", code);
  return c.json<ApiError>({ error: { code, message } }, status);
}

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
