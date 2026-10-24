/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  build: {
    // The bundle is read from disk inside the webview, never over a network, so the 500 kB default
    // (a download-time heuristic) flags a size that costs us nothing. Splitting it would only add
    // request round-trips to the asset protocol. Raised rather than silenced so a genuine jump
    // still shows up.
    chunkSizeWarningLimit: 1000,
  },

  // Agent worktrees live under .claude/worktrees — full repo copies whose tests would run twice.
  test: {
    exclude: [...configDefaults.exclude, ".claude/**"],
  },

  // Don't clear the terminal over the Rust compiler errors `tauri dev` prints.
  clearScreen: false,
  // tauri.conf.json's devUrl names this port: fail rather than drift to another one.
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // `tauri dev` watches src-tauri itself; .claude holds agent worktrees (see `test`).
      ignored: ["**/src-tauri/**", "**/.claude/**"],
    },
  },
}));
