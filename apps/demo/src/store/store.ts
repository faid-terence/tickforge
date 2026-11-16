import { combineReducers, configureStore, createListenerMiddleware } from "@reduxjs/toolkit";
import type { ChartCandle } from "../lib/candles";
import type { Command, DemoSymbol } from "../worker/protocol";
import { disconnectSimulated, historyFailed, historyLoaded } from "./actions";
import { connectionSlice } from "./connectionSlice";
import { marketSlice } from "./marketSlice";
import {
  settingsSlice,
  slowConsumerToggled,
  symbolSelected,
  themeChanged,
  type SettingsState,
} from "./settingsSlice";

/** Side-effect dependencies, injected so tests can use fakes. */
export interface StoreDeps {
  send(command: Command): void;
  fetchHistory(symbol: DemoSymbol): Promise<ChartCandle[]>;
  applyTheme(theme: SettingsState["theme"]): void;
}

const rootReducer = combineReducers({
  settings: settingsSlice.reducer,
  market: marketSlice.reducer,
  connection: connectionSlice.reducer,
});
export type RootState = ReturnType<typeof rootReducer>;

/**
 * Reducers stay pure; everything that talks to the worker, the network or
 * the DOM lives in these listeners.
 */
export function createAppStore(deps: StoreDeps, preloaded?: Partial<RootState>) {
  const listeners = createListenerMiddleware();
  const start = listeners.startListening.withTypes<RootState>();

  start({
    actionCreator: symbolSelected,
    effect: async ({ payload: symbol }, api) => {
      deps.send({ type: "select", symbol });
      // A newer selection cancels this one, so stale history never lands.
      api.cancelActiveListeners();
      try {
        const candles = await api.pause(deps.fetchHistory(symbol));
        api.dispatch(historyLoaded({ symbol, candles }));
      } catch (error) {
        if (api.signal.aborted) return;
        api.dispatch(historyFailed({ symbol, message: String(error) }));
      }
    },
  });
  start({
    actionCreator: disconnectSimulated,
    effect: () => {
      deps.send({ type: "simulate-disconnect" });
    },
  });
  start({
    actionCreator: slowConsumerToggled,
    effect: (_action, api) => {
      deps.send({ type: "slow-consumer", enabled: api.getState().settings.slowConsumer });
    },
  });
  start({
    actionCreator: themeChanged,
    effect: ({ payload }) => {
      deps.applyTheme(payload);
    },
  });

  return configureStore({
    reducer: rootReducer,
    ...(preloaded && { preloadedState: preloaded as RootState }),
    middleware: (getDefault) =>
      // Batches arrive 10x a second; the dev-only immutability/serializability
      // checks would deep-walk every one. Reducers are covered by tests instead.
      getDefault({ immutableCheck: false, serializableCheck: false }).prepend(listeners.middleware),
  });
}

export type AppStore = ReturnType<typeof createAppStore>;
export type AppDispatch = AppStore["dispatch"];
