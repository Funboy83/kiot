import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  root: 'web',
  plugins: [preact()],
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2020' },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
