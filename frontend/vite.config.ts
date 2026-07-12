/// <reference types="vitest" />
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import solid from "vite-plugin-solid"
import { defaultExclude, defineConfig } from "vitest/config"
import nodePolyfills from "vite-plugin-node-stdlib-browser"

const stripApiPrefix = (proxyPath: string): string =>
  proxyPath.replace(/^\/api/, "")

export default defineConfig({
  base: "/",
  plugins: [solid(), tailwindcss(), nodePolyfills()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "socks-proxy-agent": path.resolve(__dirname, "./src/stubs/empty.ts"),
      "http-proxy-agent": path.resolve(__dirname, "./src/stubs/empty.ts"),
      "https-proxy-agent": path.resolve(__dirname, "./src/stubs/empty.ts"),
    },
  },
  build: {
    chunkSizeWarningLimit: 6000,
    target: "esnext",
  },
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api/hyperliquid": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: stripApiPrefix,
      },
      "/api/beta": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: stripApiPrefix,
      },
      "/api/factors": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: stripApiPrefix,
      },
      "/api/portfolio": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: stripApiPrefix,
      },
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
      "/candles": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: "happy-dom",
    setupFiles: "./src/test/setup.ts",
    css: true,
    exclude: [...defaultExclude, "src/visual/**"],
    server: {
      deps: {
        inline: [/solid-js/, /@solidjs/, /@kobalte/, /@tanstack/],
      },
    },
  },
})
