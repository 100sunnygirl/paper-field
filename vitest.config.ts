import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tauriConf from "./src-tauri/tauri.conf.json" with { type: "json" };

export default defineConfig({
  plugins: [react()],
  define: {
    __PF_UPDATER_PUBKEY__: JSON.stringify(tauriConf.plugins?.updater?.pubkey ?? ""),
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
