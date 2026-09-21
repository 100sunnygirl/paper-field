import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;
const port = 43173;

export default defineConfig({
  plugins: [react()],
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
