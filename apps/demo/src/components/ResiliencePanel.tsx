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
          <dt>Gaps detected</dt>
          <dd className={counters.gaps > 0 ? "stats__alert" : undefined}>
            {counters.gaps}
            {counters.gaps > 0 && (
              <span className="stats__sub">
                {formatCompact(counters.missedTrades)} trades missed
              </span>
            )}
          </dd>
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
          Takes the network down for 3 seconds. Watch the log: tickforge retries with jittered
          backoff, reconnects and re-subscribes on its own, then compares Coinbase&apos;s
          <code> last_match</code> with the last trade it saw to count exactly which trades were
          missed. Affected candles are drawn hollow and marked incomplete.
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
