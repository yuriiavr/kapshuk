import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Інтерфейс збирається в dist/web, його віддає сам сервер (server/main.ts).
// `npm run dev` — інтерфейс із гарячим перезавантаженням, запити /api та /login ідуть на сервер на ноутбуці.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    proxy: {
      '/api': process.env.KAPSHUK_URL || 'http://192.168.31.94:8792',
      '/login': process.env.KAPSHUK_URL || 'http://192.168.31.94:8792',
    },
  },
});
