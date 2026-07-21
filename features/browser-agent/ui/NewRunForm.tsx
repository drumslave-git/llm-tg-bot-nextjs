"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Globe } from "lucide-react";

import { Button, Card, CardContent, Textarea } from "@/components/ui";

/**
 * Operator-facing "start a run" form. A dashboard run has no chat to deliver to —
 * the report lands on the run row and is read here — so this is for the operator
 * to exercise or drive the agent directly, mirroring the conversational
 * `browse_web` tool without needing Telegram.
 */
export function NewRunForm() {
  const router = useRouter();
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = goal.trim();
    if (trimmed.length < 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/browser", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: trimmed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
      }
      setGoal("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the run");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={submit} className="space-y-3">
          <Textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Describe what to find or do on the web — include any links. e.g. “Open example.com, find the pricing page, and tell me the cheapest plan.”"
            rows={3}
            disabled={busy}
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted">
              Runs in the background. The report appears below when it finishes.
            </p>
            <Button type="submit" disabled={busy || goal.trim().length < 4}>
              <Globe className="h-4 w-4" aria-hidden />
              {busy ? "Starting…" : "Start run"}
            </Button>
          </div>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </form>
      </CardContent>
    </Card>
  );
}
