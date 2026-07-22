/// <reference types="vitest" />
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import solid from "vite-plugin-solid"
import { defineConfig } from "vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"

const stripApiPrefix = (proxyPath: string): string =>
  proxyPath.replace(/^\/api/, "")

const netStub = path.resolve(__dirname, "./src/stubs/net.ts")
const dockviewSolidPart = path.resolve(
  __dirname,
  "./src/lib/dockviewSolidPart.tsx",
)

// These WalletConnect utils ship ESM under dist/esm but only declare CJS
// "main" in package.json. Vite then serves CJS as native ESM and named
// imports like `toMiliseconds` fail at runtime.
const walletConnectEsm = (packageName: string): string =>
  path.resolve(
    __dirname,
    `node_modules/@walletconnect/${packageName}/dist/esm/index.js`,
  )

/** Dockview panel portals use `render()` (detached root). Replace SolidPart so
 * panels inherit the app owner and keep WalletProvider / QueryClient context. */
const dockviewSolidContextPlugin = {
  name: "dockview-solid-context",
  enforce: "pre" as const,
  resolveId(source: string, importer: string | undefined) {
    if (!importer?.includes(`${path.sep}@arminmajerie${path.sep}dockview`)) {
      return null
    }

    const isRelativeSolid =
      source === "../solid" ||
      source === "../solid.jsx" ||
      source === "./solid" ||
      source === "./solid.jsx"
    const isAbsoluteSolid =
      source.endsWith(`${path.sep}solid.jsx`) ||
      source.endsWith(`${path.sep}solid`)

    if (isRelativeSolid || isAbsoluteSolid) {
      return dockviewSolidPart
    }

    return null
  },
}

export default defineConfig({
  base: "/",
  plugins: [
    dockviewSolidContextPlugin,
    solid(),
    tailwindcss(),
    // Buffer/process for ccxt. Keep `global` off so AppKit + lit-html can be
    // prebundled (`var global = globalThis` must not clash with a shim export).
    nodePolyfills({
      exclude: ["net"],
      globals: {
        Buffer: true,
        global: false,
        process: true,
      },
      protocolImports: true,
    }),
  ],
  optimizeDeps: {
    include: [
      "@reown/appkit",
      "@reown/appkit-adapter-ethers",
      "@reown/appkit/networks",
      "@walletconnect/time",
      "@walletconnect/environment",
      "@walletconnect/window-getters",
      "@walletconnect/window-metadata",
      "viem",
      "viem/accounts",
      "viem/chains",
      "@nktkas/hyperliquid",
    ],
    exclude: [
      "@arminmajerie/dockview-solid",
      "@arminmajerie/dockview",
      "@arminmajerie/dockview-core",
    ],
  },
  resolve: {
    alias: [
      {
        find: "@",
        replacement: path.resolve(__dirname, "./src"),
      },
      // Import only the Hyperliquid exchange instead of the ccxt barrel, which
      // statically pulls in all 100+ exchanges and defeats tree-shaking.
      {
        find: "ccxt/hyperliquid",
        replacement: path.resolve(
          __dirname,
          "node_modules/ccxt/js/src/pro/hyperliquid.js",
        ),
      },
      {
        find: "node:net",
        replacement: netStub,
      },
      {
        find: "net",
        replacement: netStub,
      },
      {
        find: "@walletconnect/time",
        replacement: walletConnectEsm("time"),
      },
      {
        find: "@walletconnect/environment",
        replacement: walletConnectEsm("environment"),
      },
      {
        find: "@walletconnect/window-getters",
        replacement: walletConnectEsm("window-getters"),
      },
      {
        find: "@walletconnect/window-metadata",
        replacement: walletConnectEsm("window-metadata"),
      },
      {
        find: "socks-proxy-agent",
        replacement: path.resolve(__dirname, "./src/stubs/empty.ts"),
      },
      {
        find: "http-proxy-agent",
        replacement: path.resolve(__dirname, "./src/stubs/empty.ts"),
      },
      {
        find: "https-proxy-agent",
        replacement: path.resolve(__dirname, "./src/stubs/empty.ts"),
      },
    ],
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
    server: {
      deps: {
        inline: [
          /solid-js/,
          /@solidjs/,
          /@kobalte/,
          /@tanstack/,
          /@arminmajerie\/dockview-solid/,
          /@arminmajerie\/dockview/,
          /@arminmajerie\/dockview-core/,
        ],
      },
    },
  },
})
