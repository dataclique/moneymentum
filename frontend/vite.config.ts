/// <reference types="vitest" />
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"
import nodePolyfills from "vite-plugin-node-stdlib-browser"

const suppressUseClientWarning = (): Plugin => {
  return {
    name: "suppress-use-client-warning",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      const originalOnWarn = config.build.rollupOptions.onwarn
      config.build.rollupOptions.onwarn = (warning, warn) => {
        if (
          warning.code === "MODULE_LEVEL_DIRECTIVE" &&
          warning.id?.includes("node_modules")
        ) {
          return
        }
        if (originalOnWarn) {
          originalOnWarn(warning, warn)
        } else {
          warn(warning)
        }
      }
    },
  }
}

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills(),
    suppressUseClientWarning(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "socks-proxy-agent": path.resolve(__dirname, "./src/stubs/empty.ts"),
    },
  },
  build: {
    chunkSizeWarningLimit: 6000,
    rollupOptions: {},
  },
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
      "/beta": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
  },
})
