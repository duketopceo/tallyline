import { describe, expect, it } from "vitest";
import { captureGlobalErrors, eventFromError, type ErrorTarget } from "./browser.js";
import type { IntakeClient, IntakeEvent, ReportResult } from "./core.js";

function fakeTarget(): { target: ErrorTarget; raise: (type: string, event: unknown) => void; types: () => string[] } {
  const handlers = new Map<string, (event: unknown) => void>();
  return {
    target: {
      addEventListener: (type, handler) => {
        handlers.set(type, handler);
      },
      removeEventListener: (type) => {
        handlers.delete(type);
      },
    },
    raise: (type, event) => {
      handlers.get(type)?.(event);
    },
    types: () => [...handlers.keys()],
  };
}

function stubClient(): { client: IntakeClient; sent: IntakeEvent[] } {
  const sent: IntakeEvent[] = [];
  return {
    sent,
    client: {
      key: "k",
      report: async (event) => {
        sent.push(event);
        return { status: "dropped" } satisfies ReportResult;
      },
    },
  };
}

describe("captureGlobalErrors", () => {
  it("reports window errors and unhandled rejections, then detaches", async () => {
    const { target, raise, types } = fakeTarget();
    const { client, sent } = stubClient();

    const dispose = captureGlobalErrors(client, { target });
    expect(types().sort()).toEqual(["error", "unhandledrejection"]);

    raise("error", { error: new TypeError("boom") });
    raise("unhandledrejection", { reason: "plain reason" });
    await Promise.resolve();

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ kind: "error", title: "boom" });
    expect(sent[1]).toMatchObject({
      kind: "error",
      title: "Unhandled error",
      payload: { value: "plain reason" },
    });

    dispose();
    expect(types()).toEqual([]);
  });

  it("does not let a failing report become a new unhandled rejection", async () => {
    const { target, raise } = fakeTarget();
    const client: IntakeClient = {
      key: "k",
      report: () => Promise.reject(new Error("offline")),
    };

    captureGlobalErrors(client, { target });

    expect(() => raise("error", new Error("boom"))).not.toThrow();
    await Promise.resolve();
  });
});

describe("eventFromError", () => {
  it("keeps the message and the stack of a real Error", () => {
    const error = new RangeError("out of range");
    const event = eventFromError(error);

    expect(event.kind).toBe("error");
    expect(event.title).toBe("out of range");
    expect(typeof event.payload?.["stack"]).toBe("string");
  });

  it("falls back to a fixed title for a non-Error value", () => {
    expect(eventFromError(undefined)).toEqual({
      kind: "error",
      title: "Unhandled error",
      payload: { value: null },
    });
  });

  it("drops a value that cannot be serialised instead of throwing", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    expect(eventFromError(circular)).toEqual({
      kind: "error",
      title: "Unhandled error",
      payload: {},
    });
  });
});
