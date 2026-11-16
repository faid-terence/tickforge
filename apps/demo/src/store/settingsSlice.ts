import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { DemoSymbol } from "../worker/protocol";

export type ThemeSetting = "system" | "light" | "dark";

export interface SettingsState {
  symbol: DemoSymbol;
  theme: ThemeSetting;
  slowConsumer: boolean;
}

const initialState: SettingsState = { symbol: "BTC-USD", theme: "system", slowConsumer: false };

export const settingsSlice = createSlice({
  name: "settings",
  initialState,
  reducers: {
    symbolSelected(state, action: PayloadAction<DemoSymbol>) {
      state.symbol = action.payload;
    },
    themeChanged(state, action: PayloadAction<ThemeSetting>) {
      state.theme = action.payload;
    },
    slowConsumerToggled(state) {
      state.slowConsumer = !state.slowConsumer;
    },
  },
});

export const { symbolSelected, themeChanged, slowConsumerToggled } = settingsSlice.actions;
