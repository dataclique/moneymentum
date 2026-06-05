/// <reference types="vitest" />
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import solid from "vite-plugin-solid"
import { defineConfig } from "vite"
import nodePolyfills from "vite-plugin-node-stdlib-browser"

export default defineConfig({
  base: "/",
  plugins: [solid(), tailwindcss(), nodePolyfills()],
  // Eagerly pre-bundle heavy Solana / Reown entry points so dev HMR does not
  // leave the browser requesting stale hashes (504 Outdated Optimize Dep).
  optimizeDeps: {
    include: [
      "@solana/web3.js",
      "@solana/spl-token",
      "@reown/appkit-utils/solana",
      "@reown/appkit",
      "@reown/appkit-adapter-solana",
    ],
  },
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
      "/api/beta": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (proxyPath: string) => proxyPath.replace(/^\/api/, ""),
      },
      "/api": {
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
    server: {
      deps: {
        inline: [/solid-js/, /@solidjs/, /@kobalte/, /@tanstack/],
      },
    },
  },
})
