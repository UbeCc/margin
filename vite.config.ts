import { defineConfig } from "vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { realpathSync } from "node:fs";
import { searchForWorkspaceRoot } from "vite";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  // Per-worktree dep cache: symlinked node_modules would otherwise share node_modules/.vite
  // across worktrees and one dev server's re-optimize reloads another's e2e pages.
  cacheDir: process.env.VITE_CACHE_DIR || '.vite-cache',

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
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
    // Worktrees symlink node_modules from the main checkout; allow serving it (KaTeX fonts etc.).
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), realpathSync("node_modules")],
    },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
