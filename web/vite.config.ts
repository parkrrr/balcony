import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Same-origin in dev, like production: cookies and the socket origin check just work.
    // changeOrigin must stay false (the string shorthand turns it on) so the server sees
    // Host: localhost:5173 and builds the OAuth redirect URI the browser is actually on.
    proxy: {
      "/api": { target: server, changeOrigin: false },
      "/auth": { target: server, changeOrigin: false },
      "/socket.io": { target: server, changeOrigin: false, ws: true },
    },
  },
});
