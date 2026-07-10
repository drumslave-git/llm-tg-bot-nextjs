import type { ReactNode } from "react";
import { Card } from "@/components/ui/Card";

export type StatusTone = "ok" | "warn" | "error" | "neutral";

const TONE_DOT: Record<StatusTone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-danger",
  neutral: "bg-faint",
};

/** Compact operational status card for the dashboard overview. */
export function StatusCard({
  label,
  value,
  tone = "neutral",
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: StatusTone;
  hint?: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full ${TONE_DOT[tone]}`}
          aria-hidden
        />
        <span className="text-xs font-medium tracking-wide text-muted uppercase">
          {label}
        </span>
      </div>
      <div className="mt-2 text-sm font-medium">{value}</div>
      {hint ? <div className="mt-1 text-xs text-faint">{hint}</div> : null}
    </Card>
  );
}
