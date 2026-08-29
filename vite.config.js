import { defineConfig } from 'vite';

export default defineConfig({
  root: 'demo',
  base: './',
  server: {
    host: true,
    port: process.env.PORT ? Number(process.env.PORT) : 5180,
    fs: { allow: ['..'] },
  },
  build: { target: 'es2020', outDir: '../dist', emptyOutDir: true },
});
