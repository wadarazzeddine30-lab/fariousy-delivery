import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Clean up any environment variables starting with VITE_ that contain invalid JS identifier characters (such as hyphens)
for (const key of Object.keys(process.env)) {
  if (key.startsWith('VITE_') && !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) {
    delete process.env[key];
  }
}

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['manifest.json', 'assets/aistudio/WhatsApp_Image_2026-10-25_at_01.07.07_dafc315a.jpeg'],
        manifest: {
          id: '/?app=driver',
          name: 'FARIOUSY Driver — تطبيق الموزع',
          short_name: 'FARIOUSY App',
          description: 'تطبيق موزع شركة FARIOUSY DELIVERY لتوزيع وتوصيل الشحنات والطرود، المسح الضوئي وإدارة الصندوق النقدي.',
          theme_color: '#dc2626',
          background_color: '#090d16',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/?app=driver',
          scope: '/',
          icons: [
            {
              src: '/assets/aistudio/WhatsApp_Image_2026-10-25_at_01.07.07_dafc315a.jpeg',
              sizes: '192x192',
              type: 'image/jpeg',
              purpose: 'any'
            },
            {
              src: '/assets/aistudio/WhatsApp_Image_2026-10-25_at_01.07.07_dafc315a.jpeg',
              sizes: '512x512',
              type: 'image/jpeg',
              purpose: 'any'
            }
          ]
        },
        workbox: {
          maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,jpeg,jpg}'],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365
                },
                cacheableResponse: {
                  statuses: [0, 200]
                }
              }
            },
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'gstatic-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365
                },
                cacheableResponse: {
                  statuses: [0, 200]
                }
              }
            }
          ]
        },
        devOptions: {
          enabled: true
        }
      })
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname || '.', '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
