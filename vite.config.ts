import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: ['.trycloudflare.com'],
    // ส่งทุกคำขอ /api ไปที่เซิร์ฟเวอร์ BahtFlow (pnpm server) เพื่อให้คุกกี้ล็อกอินอยู่ origin เดียวกับหน้าเว็บ
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } },
  },
});