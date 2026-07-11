"use client";

import {
  JsonView,
  allExpanded,
  collapseAllNested,
  darkStyles,
  defaultStyles,
} from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";

import { useIsDark } from "@/components/theme/useIsDark";

/**
 * Shared JSON viewer for trace payloads and request/response bodies. Collapsible
 * tree (react-json-view-lite — React 19-compatible), theme-aware via {@link
 * useIsDark}. Objects/arrays render as an expandable tree; primitives (e.g. a
 * full message string) render as wrapped text so nothing is ever truncated.
 */
export function JsonBlock({
  value,
  defaultExpanded = false,
}: {
  value: unknown;
  /** Expand all nodes on first render (still collapsible). Collapsed by default. */
  defaultExpanded?: boolean;
}) {
  const dark = useIsDark();
  const isTree = typeof value === "object" && value !== null;
  // Keep the library's colours/icons but drop its opaque container background
  // (a jarring solarized panel) so the tree sits flat on the surrounding card.
  const base = dark ? darkStyles : defaultStyles;
  const style = { ...base, container: "whitespace-pre-wrap break-words" };

  return (
    <div className="overflow-auto font-mono text-xs leading-relaxed">
      {isTree ? (
        <JsonView
          data={value as object}
          style={style}
          shouldExpandNode={defaultExpanded ? allExpanded : collapseAllNested}
          clickToExpandNode
        />
      ) : (
        <pre className="break-words whitespace-pre-wrap text-foreground/90">
          {value === undefined ? "undefined" : String(value)}
        </pre>
      )}
    </div>
  );
}
