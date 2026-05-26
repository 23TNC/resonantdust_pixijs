import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    allowedHosts: [
      'resonantdust.com',
      'www.resonantdust.com',
      '.resonantdust.com',     // allows all subdomains (recommended)
      'localhost',
      '127.0.0.1'
    ],
  },
  build: {
    sourcemap: false,
  },
  optimizeDeps: {
    esbuildOptions: {
      sourcemap: false,
    },
  },

});