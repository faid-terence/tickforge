import { memo } from "react";
import { formatCompact } from "../lib/format";
import type { Counters } from "../worker/protocol";

export interface ResiliencePanelProps {
  counters: Counters;
  slowConsumer: boolean;
  /** Disables the disconnect button while there is nothing to drop. */
  connected: boolean;
  onSimulateDisconnect: () => void;
  onToggleSlowConsumer: () => void;
}

/** Lets a visitor stress the SDK and watch it recover. */
export const ResiliencePanel = memo(function ResiliencePanel({
  counters,
  slowConsumer,
  connected,
  onSimulateDisconnect,
  onToggleSlowConsumer,
}: ResiliencePanelProps) {
  return (
    <div className="resilience">
      <dl className="stats">
        <div>
          <dt>Reconnects</dt>
          <dd>{counters.reconnects}</dd>
        </div>
        <div>
          <dt>Dropped by loop</dt>
          <dd className={counters.dropped > 0 ? "stats__alert" : undefined}>
            {formatCompact(counters.dropped)}
          </dd>
        </div>
        <div>
          <dt>Trades received</dt>
          <dd>{formatCompact(counters.tradesReceived)}</dd>
        </div>
      </dl>

      <div className="control">
        <button
          type="button"
          className="button button--primary"
          onClick={onSimulateDisconnect}
          disabled={!connected}
        >
          Simulate disconnect
        </button>
        <p className="muted">
          Closes the socket like a network failure. Watch the log: tickforge backs off with jitter,
          reconnects and re-subscribes on its own.
        </p>
      </div>

      <div className="control">
        <label className="switch">
          <input type="checkbox" checked={slowConsumer} onChange={onToggleSlowConsumer} />
          <span className="switch__track" aria-hidden="true" />
          Slow consumer
        </label>
        <p className="muted">
          Makes the <code>for await</code> loop feeding the trade list handle ~4 trades/s with a
          20-trade buffer. When the feed is faster, the oldest trades are dropped and counted;
          candles stay complete because the SDK builds them from every trade.
        </p>
      </div>
    </div>
  );
});
