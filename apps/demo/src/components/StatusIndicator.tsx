import { memo } from "react";
import { formatDuration } from "../lib/format";
import type { StatusSnapshot } from "../worker/protocol";

export interface StatusIndicatorProps {
  status: StatusSnapshot;
}

const LABELS = {
  idle: { icon: "○", tone: "neutral", text: "Idle" },
  connecting: { icon: "◌", tone: "warning", text: "Connecting" },
  open: { icon: "●", tone: "good", text: "Live" },
  reconnecting: { icon: "↻", tone: "warning", text: "Reconnecting" },
  closed: { icon: "■", tone: "critical", text: "Closed" },
} as const;

/**
 * Connection state as a pill. State is never colour alone: each has its own
 * icon and label, and the colour comes from the reserved status palette.
 */
export const StatusIndicator = memo(function StatusIndicator({ status }: StatusIndicatorProps) {
  const label = LABELS[status.state];
  const detail =
    status.state === "reconnecting" && status.attempt !== undefined
      ? `attempt ${String(status.attempt)}, retry in ${formatDuration(status.retryInMs ?? 0)}`
      : undefined;
  return (
    <div className={`status status--${label.tone}`} role="status" aria-live="polite">
      <span className="status__icon" aria-hidden="true">
        {label.icon}
      </span>
      <span className="status__text">{label.text}</span>
      {detail && <span className="status__detail">{detail}</span>}
    </div>
  );
});
