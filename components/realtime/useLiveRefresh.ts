"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { RealtimeEvent, RealtimeTopic } from "@/lib/realtime";

/**
 * Subscribe a Server Component view to live updates over the shared SSE stream.
 *
 * Opens one `EventSource` to `/api/events`, and on any event matching `topic` (a
 * single topic, or any of several — the consolidated Jobs board watches all six
 * job topics at once) triggers a debounced `router.refresh()` — the page re-runs
 * its server read and the fresh data streams in, no client-side data
 * duplication. `EventSource` reconnects automatically; `enabled=false` pauses
 * (closes the stream).
 *
 * Returns `{ connected }` for a live indicator.
 */
export function useLiveRefresh(
  topic: RealtimeTopic | RealtimeTopic[],
  { enabled = true, debounceMs = 400 }: { enabled?: boolean; debounceMs?: number } = {},
): { connected: boolean } {
  const router = useRouter();
  const [connected, setConnected] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A stable primitive dep so passing a fresh array literal each render does not
  // tear down and re-open the stream.
  const topicKey = (Array.isArray(topic) ? topic : [topic]).join(",");

  useEffect(() => {
    if (!enabled) return;

    const topics = new Set(topicKey.split(",") as RealtimeTopic[]);
    const source = new EventSource("/api/events");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false); // EventSource retries on its own
    source.onmessage = (message) => {
      let event: RealtimeEvent;
      try {
        event = JSON.parse(message.data) as RealtimeEvent;
      } catch {
        return;
      }
      if (!topics.has(event.topic)) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), debounceMs);
    };

    return () => {
      source.close();
      if (timer.current) clearTimeout(timer.current);
      setConnected(false);
    };
  }, [enabled, topicKey, debounceMs, router]);

  return { connected };
}
