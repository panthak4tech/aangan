import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;
const sourceDirectory = fileURLToPath(new URL("./src", import.meta.url));

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(sourceDirectory),
    },
  },

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
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    coverage: {
      provider: "v8" as const,
      reporter: ["text-summary", "lcov", "cobertura"],
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 65,
        branches: 60,
      },
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        ...configDefaults.exclude,
        "src/**/*.d.ts",
        "src/main.tsx",
        "src/test/**",
        "src/components/ui/**",
      ],
    },
  },
}));
