import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tauriConf from "./src-tauri/tauri.conf.json" with { type: "json" };

const host = process.env.TAURI_DEV_HOST;
const port = 43173;

export default defineConfig({
  plugins: [react()],
  define: {
    __PF_UPDATER_PUBKEY__: JSON.stringify(tauriConf.plugins?.updater?.pubkey ?? ""),
  },
  clearScreen: false,
  server: {
    port,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? { protocol: "ws", host, port: port + 1 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  preview: {
    port,
    host: "127.0.0.1",
  },
});
