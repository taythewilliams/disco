import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dashboard and the projector are served by the same Node process in
 * production. In dev they run on their own port and proxy, so the session
 * cookie and the WebSocket both behave exactly as they will at the venue.
 *
 * `base: '/host/'` because two Vite builds share one origin: the guest PWA sits
 * at the root and both apps emit an `assets/` directory, so one would shadow
 * the other. The server then maps `/dj` and `/display` onto this bundle's
 * index, which is what actually gets typed into a browser at setup (D8).
 */
export default defineConfig({
  base: '/host/',
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/media': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
