import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * The guest shell (D4, D15).
 *
 * This is the bundle thirty phones fetch at the door, so it is a separate Vite
 * app from the dashboard specifically so the dashboard's weight — tables,
 * charts, search — can never leak into it. The budget is checked in `build`,
 * not hoped for.
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png', 'favicon.png'],
      manifest: {
        name: 'Disco',
        short_name: 'Disco',
        description: 'Synced music, in your headphones.',
        // Standalone so the installed app has no browser chrome — and, on iOS,
        // its own storage container and service worker registration (D15).
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0f1115',
        theme_color: '#0f1115',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          // Maskable variants keep their content inside the inner 80 %, because
          // Android crops to whatever shape the launcher uses.
          { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the shell and nothing else. Audio segments are large,
        // content-hashed and already managed by the client's own cache with its
        // own eviction — putting them in the service worker as well would
        // duplicate tens of megabytes on a phone that has none to spare (D2).
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // Never let the navigation fallback swallow these: `/ws` is a WebSocket
        // upgrade, `/api` is live state, `/media` is audio. A cached answer to
        // any of them is a bug that presents as the room being out of sync.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/media\//, /^\/ws$/],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/media': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
