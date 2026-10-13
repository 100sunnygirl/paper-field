/// <reference types="vite/client" />

import type initSqlJs from "sql.js";

declare global {
  interface Window {
    initSqlJs?: typeof initSqlJs;
  }

  const __PF_UPDATER_PUBKEY__: string;
}

export {};
