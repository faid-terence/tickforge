import { createSlice } from "@reduxjs/toolkit";
import type { LogEntry, StatusSnapshot } from "../worker/protocol";
import { batchReceived } from "./actions";

export const MAX_LOG = 40;

export interface ConnectionState {
  status: StatusSnapshot;
  /** Newest first. */
  log: LogEntry[];
}

const initialState: ConnectionState = {
  status: { state: "idle", since: Date.now() },
  log: [],
};

export const connectionSlice = createSlice({
  name: "connection",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder.addCase(batchReceived, (state, { payload: batch }) => {
      if (batch.status) state.status = batch.status;
      if (batch.log.length > 0) {
        state.log = [...batch.log].reverse().concat(state.log).slice(0, MAX_LOG);
      }
    });
  },
});
