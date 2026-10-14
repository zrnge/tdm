import { defineConfig } from 'vite';

// Production is served from https://zrnge.com/tdm/, so the build resolves every
// asset under /tdm/. The dev server stays at the root (http://localhost:5173/).
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/tdm/' : '/',
  server: {
    port: 5173,
    open: false,
    fs: { strict: false },
  },
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: 'index.html',
        inspect: 'inspect.html',
      },
    },
  },
}));
