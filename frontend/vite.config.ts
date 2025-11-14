import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // 💡 START OF REQUIRED SERVER/PROXY CONFIGURATION 💡
  server: {
    // 1. Host setting allows external access (as you used --host)
    host: "0.0.0.0",

    // 2. Proxy routes API calls from Vite (5173) to your backend (8000)
    proxy: {
      // When the frontend asks for /api/date-range...
      "/api": {
        // ...forward the request to the backend server's internal address
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        // (Optional) Remove the /api prefix if your backend doesn't expect it
        // rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  // 💡 END OF REQUIRED SERVER/PROXY CONFIGURATION 💡
})
