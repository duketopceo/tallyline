// Browser entry: everything in the neutral client, plus an opt-in capture of
// the two globals an embedder usually forgets — `window.onerror` and unhandled
// promise rejections. Nothing is installed until `captureGlobalErrors` is
// called.
export * from "./core.js";

import type { IntakeClient, IntakeEvent } from "./core.js";

export interface ErrorTarget {
  addEventListener(type: string, handler: (event: unknown) => void): void;
  removeEventListener(type: string, handler: (event: unknown) => void): void;
}

function isErrorTarget(value: unknown): value is ErrorTarget {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    addEventListener?: unknown;
    removeEventListener?: unknown;
  };
  return (
    typeof candidate.addEventListener === "function" &&
    typeof candidate.removeEventListener === "function"
  );
}

function reportedError(event: unknown): unknown {
  if (typeof event === "object" && event !== null && "error" in event) {
    return (event as { error: unknown }).error;
  }
  return event;
}

function rejectedReason(event: unknown): unknown {
  if (typeof event === "object" && event !== null && "reason" in event) {
    return (event as { reason: unknown }).reason;
  }
  return event;
}

/** An unknown value is kept only when it survives JSON; a circular one would
 * otherwise throw while the error handler is already handling an error. */
function safeValue(value: unknown): Record<string, unknown> {
  try {
    JSON.stringify(value);
    return { value: value ?? null };
  } catch {
    return {};
  }
}

export function eventFromError(error: unknown): IntakeEvent {
  if (error instanceof Error) {
    return {
      kind: "error",
      title: error.message || "Unhandled error",
      payload: { stack: error.stack ?? null },
    };
  }
  return { kind: "error", title: "Unhandled error", payload: safeValue(error) };
}

/** Report uncaught errors and unhandled rejections. Returns a disposer. */
export function captureGlobalErrors(
  client: IntakeClient,
  options: { target?: ErrorTarget } = {},
): () => void {
  const target = options.target ?? globalTarget();
  const onError = (event: unknown): void => {
    void client.report(eventFromError(reportedError(event))).catch(() => {});
  };
  const onRejection = (event: unknown): void => {
    void client
      .report(eventFromError(rejectedReason(event)))
      .catch(() => {});
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

function globalTarget(): ErrorTarget {
  if (!isErrorTarget(globalThis)) {
    throw new Error(
      "intake-client: captureGlobalErrors needs a browser; pass options.target",
    );
  }
  return globalThis;
}
