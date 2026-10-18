import { afterEach, describe, expect, it, vi } from "vitest";
import { SECRET_TTL_MS, armSecretExpiry, secretTestId } from "./secret-expiry";

afterEach(() => vi.useRealTimers());

function fakeDoc() {
  const listeners = new Set<() => void>();
  return {
    hidden: false,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    fire() {
      listeners.forEach((l) => l());
    },
    count: () => listeners.size,
  };
}

describe("secret expiry", () => {
  it("expires after about five minutes", () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const expire = vi.fn();
    armSecretExpiry(doc, expire);
    vi.advanceTimersByTime(SECRET_TTL_MS - 1);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(expire).toHaveBeenCalledTimes(1);
    expect(SECRET_TTL_MS).toBe(5 * 60_000);
  });
  it("expires when the tab is hidden, not when it becomes visible", () => {
    const doc = fakeDoc();
    const expire = vi.fn();
    armSecretExpiry(doc, expire);
    doc.fire();
    expect(expire).not.toHaveBeenCalled();
    doc.hidden = true;
    doc.fire();
    expect(expire).toHaveBeenCalledTimes(1);
  });
  it("cleanup removes the listener and the timer", () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const expire = vi.fn();
    const off = armSecretExpiry(doc, expire);
    off();
    expect(doc.count()).toBe(0);
    vi.advanceTimersByTime(SECRET_TTL_MS * 2);
    expect(expire).not.toHaveBeenCalled();
  });
  it("test id only outside production", () => {
    expect(secretTestId("development")).toBe("secret-value");
    expect(secretTestId("test")).toBe("secret-value");
    expect(secretTestId("production")).toBeUndefined();
  });
});
