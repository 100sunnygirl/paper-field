/// <reference types="vite/client" />

import type initSqlJs from "sql.js";

declare global {
  interface Window {
    initSqlJs?: typeof initSqlJs;
  }
}

export {};
