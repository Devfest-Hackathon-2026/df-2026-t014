// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { testDom } from "./testDom";
import {
  useConcurrentSessionWarning,
  SESSION_PEER_TTL_MS,
} from "./useConcurrentSessionWarning";
class Channel {
  static all: Channel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  sent: unknown[] = [];
  constructor(readonly name: string) {
    Channel.all.push(this);
  }
  postMessage(data: unknown) {
    this.sent.push(data);
    for (const c of Channel.all)
      if (c !== this && !c.closed && c.name === this.name)
        c.onmessage?.({ data } as MessageEvent);
  }
  close() {
    this.closed = true;
  }
  receive(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}
let h: ReturnType<typeof testDom> | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  vi.useRealTimers();
  Channel.all = [];
});
function Display({
  classId = "one",
  id = "A",
}: {
  classId?: string;
  id?: string;
}) {
  return (
    <output data-id={id}>
      {useConcurrentSessionWarning(classId) ? "warning" : "clear"}
    </output>
  );
}
async function setup() {
  h = testDom();
  vi.stubGlobal("BroadcastChannel", Channel);
  await h.render(<Display />);
  return Channel.all[0];
}
describe("PF-G056 advisory concurrent session presence", () => {
  it("PF-G056 normal peer cleanup clears remaining tab immediately", async () => {
    await setup();
    await h!.render(
      <>
        <Display />
        <Display id="B" />
      </>,
    );
    expect(
      [...h!.container.querySelectorAll("output")].map((x) => x.textContent),
    ).toEqual(["warning", "warning"]);
    await h!.render(<Display />);
    expect(h!.container.textContent).toBe("clear");
    expect(
      Channel.all.some(
        (c) =>
          c.closed &&
          c.sent.some((v) => (v as { type: string }).type === "bye"),
      ),
    ).toBe(true);
  });
  it("PF-G056 vanished peers expire at TTL while live heartbeats renew presence", async () => {
    vi.useFakeTimers();
    const c = await setup();
    await act(async () => {
      c.receive({ type: "hello", id: "peer", classId: "one" });
    });
    expect(h!.container.textContent).toBe("warning");
    await act(async () => {
      vi.advanceTimersByTime(SESSION_PEER_TTL_MS - 1);
    });
    expect(h!.container.textContent).toBe("warning");
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(h!.container.textContent).toBe("clear");
    await act(async () => {
      c.receive({ type: "heartbeat", id: "peer", classId: "one" });
      vi.advanceTimersByTime(10000);
      c.receive({ type: "heartbeat", id: "peer", classId: "one" });
      vi.advanceTimersByTime(5000);
    });
    expect(h!.container.textContent).toBe("warning");
  });
  it("PF-G056 class change resets peers and ignores old channel or wrong-class messages", async () => {
    const old = await setup();
    await act(async () => {
      old.receive({ type: "hello", id: "peer", classId: "one" });
    });
    await h!.render(<Display classId="two" />);
    expect(h!.container.textContent).toBe("clear");
    const current = Channel.all.at(-1)!;
    await act(async () => {
      old.receive({ type: "heartbeat", id: "peer", classId: "one" });
      current.receive({ type: "hello", id: "peer", classId: "one" });
    });
    expect(h!.container.textContent).toBe("clear");
    expect(old.closed).toBe(true);
  });
  it("PF-G056 rejects invalid messages and self IDs without changing warning", async () => {
    const c = await setup();
    const own = (c.sent[0] as { id: string }).id;
    await act(async () => {
      for (const data of [
        null,
        [],
        { type: "bad", id: "peer", classId: "one" },
        { type: "hello", id: own, classId: "one" },
        { type: "hello", id: "", classId: "one" },
        { type: "hello", id: 3, classId: "one" },
        { type: "hello", id: "x".repeat(129), classId: "one" },
      ])
        c.receive(data);
    });
    expect(h!.container.textContent).toBe("clear");
  });
  it("PF-G056 pagehide sends bye and pageshow reannounces without a permanent warning", async () => {
    const c = await setup();
    await act(async () => {
      c.receive({ type: "hello", id: "peer", classId: "one" });
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(c.sent.at(-1)).toMatchObject({ type: "bye" });
    expect(h!.container.textContent).toBe("clear");
    await act(async () => {
      window.dispatchEvent(new Event("pageshow"));
    });
    expect(c.sent.at(-1)).toMatchObject({ type: "hello" });
  });
});
