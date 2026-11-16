import { useCallback } from "react";
import { CandleChart } from "./components/CandleChart";
import { ConnectionLog } from "./components/ConnectionLog";
import { ResiliencePanel } from "./components/ResiliencePanel";
import { StatusIndicator } from "./components/StatusIndicator";
import { SymbolPicker } from "./components/SymbolPicker";
import { ThemeToggle } from "./components/ThemeToggle";
import { Ticker } from "./components/Ticker";
import { TradesList } from "./components/TradesList";
import { disconnectSimulated } from "./store/actions";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import { selectChange } from "./store/selectors";
import { slowConsumerToggled, symbolSelected, themeChanged } from "./store/settingsSlice";
import type { DemoSymbol } from "./worker/protocol";

const REPO = "https://github.com/faid-terence/tickforge";
/** Set by `pnpm deploy:demo`, so the live demo shows exactly which commit it runs. */
const COMMIT = import.meta.env.VITE_DEMO_COMMIT;

export function App() {
  const dispatch = useAppDispatch();
  const settings = useAppSelector((s) => s.settings);
  const market = useAppSelector((s) => s.market);
  const connection = useAppSelector((s) => s.connection);
  const change = useAppSelector(selectChange);

  const onSymbol = useCallback((s: DemoSymbol) => dispatch(symbolSelected(s)), [dispatch]);
  const onDisconnect = useCallback(() => dispatch(disconnectSimulated()), [dispatch]);
  const onSlow = useCallback(() => dispatch(slowConsumerToggled()), [dispatch]);

  return (
    <div className="page">
      <header className="header">
        <a className="brand" href={REPO}>
          <span className="brand__mark" aria-hidden="true">
            <i />
            <i />
          </span>
          tickforge
          <span className="brand__tag">live demo</span>
        </a>
        <nav className="header__actions">
          <ThemeToggle value={settings.theme} onChange={(t) => dispatch(themeChanged(t))} />
          <a className="button button--ghost" href={REPO}>
            GitHub
          </a>
        </nav>
      </header>

      <div className="toolbar">
        <SymbolPicker value={settings.symbol} onChange={onSymbol} />
        <StatusIndicator status={connection.status} />
      </div>

      <main className="grid">
        <div className="col">
          <section className="card card--market" aria-labelledby="market-title">
            <h2 id="market-title" className="visually-hidden">
              Price
            </h2>
            <Ticker
              symbol={market.symbol}
              price={market.lastPrice}
              tick={market.tick}
              change={change?.fraction}
              changeSpanMinutes={change?.minutes ?? 0}
            />
            <div className="card__subhead">
              <h3>1-minute candles</h3>
              {market.history === "failed" ? (
                <span className="notice" role="status">
                  <span aria-hidden="true">ⓘ</span> History unavailable, showing live candles only
                </span>
              ) : (
                <span className="muted">Last hour · newest candle forms live from trades</span>
              )}
            </div>
            <CandleChart
              candles={market.candles}
              lastPrice={market.lastPrice}
              emptyMessage={
                market.history === "failed"
                  ? "Couldn't load recent history. Candles will build live as trades arrive."
                  : "Loading the last hour…"
              }
            />
          </section>

          <section className="card card--trades" aria-labelledby="trades-title">
            <h2 id="trades-title">Recent trades</h2>
            <TradesList trades={market.trades} />
          </section>
        </div>

        <div className="col">
          <section className="card card--resilience" aria-labelledby="resilience-title">
            <h2 id="resilience-title">Watch the SDK recover</h2>
            <ResiliencePanel
              counters={market.counters}
              slowConsumer={settings.slowConsumer}
              connected={connection.status.state === "open"}
              onSimulateDisconnect={onDisconnect}
              onToggleSlowConsumer={onSlow}
            />
          </section>

          <section className="card card--log" aria-labelledby="log-title">
            <h2 id="log-title">Connection log</h2>
            <ConnectionLog entries={connection.log} />
          </section>
        </div>
      </main>

      <footer className="footer muted">
        Data from the public Coinbase Exchange feed. The SDK runs in a Web Worker and sends the UI
        one update every 100ms. <a href={REPO}>Source and docs</a>
        {COMMIT && (
          <>
            {" · build "}
            <a href={`${REPO}/commit/${COMMIT}`}>{COMMIT.slice(0, 7)}</a>
          </>
        )}
      </footer>
    </div>
  );
}
