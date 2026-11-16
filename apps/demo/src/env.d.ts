/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Commit the demo was built from, stamped by `pnpm deploy:demo`. Absent in dev. */
  readonly VITE_DEMO_COMMIT?: string;
}
