import { memo } from "react";
import { formatClock } from "../lib/format";
import type { LogEntry } from "../worker/protocol";

export interface ConnectionLogProps {
  entries: readonly LogEntry[];
}

const PREFIX: Record<LogEntry["kind"], string> = {
  status: "state",
  "wire-out": "→ sent",
  "wire-in": "← recv",
  error: "error",
  warning: "warn",
  info: "demo",
};

/** Status changes and subscription frames, newest first. */
export const ConnectionLog = memo(function ConnectionLog({ entries }: ConnectionLogProps) {
  if (entries.length === 0) return <p className="muted empty">Nothing yet.</p>;
  return (
    <ol className="log" aria-label="Connection log, newest first">
      {entries.map((e) => (
        <li key={e.id} className={`log__entry log__entry--${e.kind}`}>
          <time>{formatClock(e.time)}</time>
          <span className="log__kind">{PREFIX[e.kind]}</span>
          <span className="log__text">{e.text}</span>
        </li>
      ))}
    </ol>
  );
});
