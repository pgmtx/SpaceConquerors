import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    define: {
      'import.meta.env.API_TOKEN': JSON.stringify(env.API_TOKEN || ''),
    },
    server: {
      port: 4200,
    },
  }
})
