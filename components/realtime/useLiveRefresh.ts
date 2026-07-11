"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { RealtimeEvent, RealtimeTopic } from "@/lib/realtime";

/**
 * Subscribe a Server Component view to live updates over the shared SSE stream.
 *
 * Opens one `EventSource` to `/api/events`, and on any event matching `topic`
 * triggers a debounced `router.refresh()` — the page re-runs its server read and
 * the fresh data streams in, no client-side data duplication. `EventSource`
 * reconnects automatically; `enabled=false` pauses (closes the stream).
 *
 * Returns `{ connected }` for a live indicator.
 */
export function useLiveRefresh(
  topic: RealtimeTopic,
  { enabled = true, debounceMs = 400 }: { enabled?: boolean; debounceMs?: number } = {},
): { connected: boolean } {
  const router = useRouter();
  const [connected, setConnected] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;

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
      if (event.topic !== topic) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), debounceMs);
    };

    return () => {
      source.close();
      if (timer.current) clearTimeout(timer.current);
      setConnected(false);
    };
  }, [enabled, topic, debounceMs, router]);

  return { connected };
}
