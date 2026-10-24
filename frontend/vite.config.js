import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// Why HTTPS?
// Browsers only allow camera, microphone and screen sharing on
// "secure" pages: https://... or http://localhost. The second laptop opens
// http://HOST_IP:5173, which is NOT secure, so its camera never starts.
// basicSsl() gives the dev server a self-signed certificate so both laptops
// can open https://HOST_IP:5173.
//
// Why a proxy?
// An https page is not allowed to talk to an http backend (mixed content).
// So the browser talks only to Vite (https), and Vite forwards /api and
// /socket.io to the Node backend on the host laptop.
//
// Run `npm run dev:http` to use the old plain-http mode (camera works only
// on the host laptop via http://localhost:5173).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backend = env.BACKEND_URL || 'http://localhost:5000'
  const useHttps = mode !== 'http'

  return {
    plugins: [react(), ...(useHttps ? [basicSsl()] : [])],
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        '/socket.io': { target: backend, changeOrigin: true, ws: true },
        '/health': { target: backend, changeOrigin: true }
      }
    },
    preview: {
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        '/socket.io': { target: backend, changeOrigin: true, ws: true }
      }
    }
  }
})
