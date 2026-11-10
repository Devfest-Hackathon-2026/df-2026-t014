import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkDocsSource,
  listenForDocsSource,
  sendDocsSettings,
} from "./docsBridge";

function bridge() {
  const nonce = "12345678-1234-1234-1234-123456789012",
    origin = "https://test.googleusercontent.com";
  const listeners = new Set<(event: MessageEvent) => void>();
  const parent = { postMessage: vi.fn() };
  const browser = {
    parent,
    location: {
      hash: `#paperflowBridge=${nonce}&paperflowParentOrigin=${encodeURIComponent(origin)}`,
    },
    addEventListener: (
      _name: string,
      callback: (event: MessageEvent) => void,
    ) => listeners.add(callback),
    removeEventListener: (
      _name: string,
      callback: (event: MessageEvent) => void,
    ) => listeners.delete(callback),
  };
  vi.stubGlobal("window", browser);
  const message = (data: unknown, source = parent, from = origin) => {
    for (const listener of listeners)
      listener({ data, source, origin: from } as unknown as MessageEvent);
  };
  return { nonce, origin, listeners, parent, message };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("Docs message boundary", () => {
  it("ignores wrong-origin messages and retains only approved source fields", () => {
    const b = bridge(),
      receive = vi.fn(),
      dispose = listenForDocsSource(receive);
    const source = {
      documentId: "doc",
      name: "原稿.pdf",
      base64: btoa("%PDF-1.7 fake"),
      accountEmail: "Teacher@Example.test",
      sourceHash: "a".repeat(64),
      defaults: {
        className: "架空",
        title: "同意書",
        access_token: "must not pass",
      },
      access_token: "must not pass",
    };
    b.message(
      { type: "paperflow:docs-source", nonce: b.nonce, source },
      b.parent,
      "https://untrusted.example",
    );
    expect(receive).not.toHaveBeenCalled();
    b.message({ type: "paperflow:docs-source", nonce: b.nonce, source });
    expect(receive.mock.calls[0][0]).toMatchObject({
      documentId: "doc",
      accountEmail: "teacher@example.test",
      defaults: { className: "架空", title: "同意書" },
    });
    expect(JSON.stringify(receive.mock.calls[0][0])).not.toContain(
      "must not pass",
    );
    dispose();
    expect(b.listeners.size).toBe(0);
  });
  it("sends settings only to the bound parent origin", () => {
    const b = bridge();
    sendDocsSettings({
      className: "架空",
      qrCorner: "top-left",
      ...({ access_token: "must not pass" } as object),
    });
    const [message, origin] = b.parent.postMessage.mock.calls[0];
    expect(origin).toBe(b.origin);
    expect(message.nonce).toBe(b.nonce);
    expect(message.settings).toEqual({
      className: "架空",
      qrCorner: "top-left",
    });
  });
  it("does not accept an unchanged claim when the returned fingerprint changed", async () => {
    const b = bridge();
    const result = checkDocsSource("a".repeat(64));
    const request = b.parent.postMessage.mock.calls[0][0];
    b.message({
      type: "paperflow:source-check",
      nonce: b.nonce,
      requestId: request.requestId,
      unchanged: true,
      sourceHash: "b".repeat(64),
    });
    await expect(result).resolves.toMatchObject({ unchanged: false });
    expect(b.listeners.size).toBe(0);
  });
  it("cleans up an unresponsive source recheck and reports a retryable failure", async () => {
    vi.useFakeTimers();
    const b = bridge();
    const result = checkDocsSource("a".repeat(64));
    const rejection =
      expect(result).rejects.toThrow("時間内に完了しませんでした");
    vi.advanceTimersByTime(60_000);
    await rejection;
    expect(b.listeners.size).toBe(0);
  });
});

describe("PF bridge rejection execution", () => {
  for (const kind of ["source", "origin", "nonce"] as const)
    it(`${{ source: "PF-G024", origin: "PF-G025", nonce: "PF-G026" }[kind]} ignores forged source message then accepts only matching parent`, () => {
      const b = bridge(),
        receive = vi.fn(),
        dispose = listenForDocsSource(receive);
      const source = {
        documentId: "current",
        name: "架空.pdf",
        base64: btoa("%PDF-fixture"),
        accountEmail: "teacher@example.test",
      };
      const data = {
        type: "paperflow:docs-source",
        nonce: kind === "nonce" ? "wrong" : b.nonce,
        source,
      };
      b.message(
        data,
        kind === "source" ? { postMessage: vi.fn() } : b.parent,
        kind === "origin" ? "https://other.example" : b.origin,
      );
      expect(receive).not.toHaveBeenCalled();
      expect(b.parent.postMessage).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(b.parent.postMessage.mock.calls)).not.toContain(
        "base64",
      );
      b.message({ ...data, nonce: b.nonce });
      expect(receive).toHaveBeenCalledOnce();
      expect(receive.mock.calls[0][0].documentId).toBe("current");
      dispose();
    });
  it("PF-G027 expired source-check reply stays rejected and requires a new request", async () => {
    vi.useFakeTimers();
    const b = bridge();
    const pending = checkDocsSource("a".repeat(64));
    const request = b.parent.postMessage.mock.calls[0][0];
    const rejection = expect(pending).rejects.toThrow("時間内");
    vi.advanceTimersByTime(60000);
    await rejection;
    b.message({
      type: "paperflow:source-check",
      nonce: b.nonce,
      requestId: request.requestId,
      unchanged: true,
      sourceHash: "a".repeat(64),
    });
    expect(b.listeners.size).toBe(0);
    const fresh = checkDocsSource("a".repeat(64));
    const next = b.parent.postMessage.mock.calls[1][0];
    expect(next.requestId).not.toBe(request.requestId);
    b.message({
      type: "paperflow:source-check",
      nonce: b.nonce,
      requestId: next.requestId,
      unchanged: true,
      sourceHash: "a".repeat(64),
    });
    await expect(fresh).resolves.toMatchObject({ unchanged: true });
  });
});
