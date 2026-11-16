import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { App } from "./App";
import { fetchHistory } from "./lib/history";
import { applyTheme, loadTheme } from "./lib/theme";
import { batchReceived } from "./store/actions";
import { symbolSelected, themeChanged } from "./store/settingsSlice";
import { createAppStore } from "./store/store";
import type { Command, WorkerMessage } from "./worker/protocol";
import "./styles.css";

// The whole SDK lives in this worker; the main thread only renders.
const worker = new Worker(new URL("./worker/market.worker.ts", import.meta.url), {
  type: "module",
  name: "tickforge",
});

const store = createAppStore({
  send: (command: Command) => {
    worker.postMessage(command);
  },
  fetchHistory: (symbol) => fetchHistory(symbol),
  applyTheme,
});

worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
  store.dispatch(batchReceived(event.data));
});

store.dispatch(themeChanged(loadTheme()));
store.dispatch(symbolSelected(store.getState().settings.symbol));

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
createRoot(root).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>,
);
