import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// WebXR requires a secure context. On a headset (Quest) the page is loaded over
// the LAN, so serve HTTPS with a self-signed cert and listen on all interfaces.
export default defineConfig({
  // Relative asset paths so the build works under a GitHub Pages sub-path.
  base: './',
  plugins: [basicSsl()],
  server: { host: true, https: true, port: 5173 },
  preview: { host: true, https: true, port: 4173 },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 800 },
});
