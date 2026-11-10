import { useEffect, useState } from "react";

export const SESSION_HEARTBEAT_MS = 5_000;
export const SESSION_PEER_TTL_MS = 15_000;
const channelName = "paperflow-session";
type PresenceType = "hello" | "present" | "heartbeat" | "bye";
/** Presence is advisory only: ledger revision checks remain the write safeguard. */
export function useConcurrentSessionWarning(classId: string): boolean {
  const [warning, setWarning] = useState(false);
  useEffect(() => {
    setWarning(false);
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(channelName);
    const id = crypto.randomUUID();
    const peers = new Map<string, number>();
    let closed = false,
      paused = false;
    const publish = (type: PresenceType) => {
      if (!closed) channel.postMessage({ type, id, classId });
    };
    const update = () => {
      if (!closed) setWarning(peers.size > 0);
    };
    channel.onmessage = (event: MessageEvent) => {
      if (closed || paused) return;
      const value = event.data as Record<string, unknown> | null;
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        value.classId !== classId ||
        typeof value.id !== "string" ||
        !/^[a-z0-9-]{1,128}$/i.test(value.id) ||
        value.id === id ||
        typeof value.type !== "string" ||
        !["hello", "present", "heartbeat", "bye"].includes(value.type)
      )
        return;
      if (value.type === "bye") peers.delete(value.id);
      else {
        peers.set(value.id, Date.now());
        if (value.type === "hello") publish("present");
      }
      update();
    };
    const leave = () => {
      if (closed || paused) return;
      publish("bye");
      paused = true;
      peers.clear();
      update();
    };
    const enter = () => {
      if (closed || !paused) return;
      paused = false;
      publish("hello");
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", enter);
    publish("hello");
    const timer = setInterval(() => {
      if (paused || closed) return;
      const now = Date.now();
      for (const [peer, seen] of peers)
        if (now - seen >= SESSION_PEER_TTL_MS) peers.delete(peer);
      update();
      publish("heartbeat");
    }, SESSION_HEARTBEAT_MS);
    return () => {
      publish("bye");
      closed = true;
      peers.clear();
      clearInterval(timer);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", enter);
      channel.onmessage = null;
      channel.close();
    };
  }, [classId]);
  return warning;
}
