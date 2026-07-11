/**
 * Shared JSON viewer for trace event payloads, metadata, and usage. Server-safe
 * (no client JS): pretty-prints a client-safe value into a scrollable code block.
 */
export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-xs leading-relaxed text-foreground/90">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
