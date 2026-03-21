import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 4200,
    proxy: {
      '/equipes': 'http://localhost:3000',
      '/monde': 'http://localhost:3000',
      '/market': 'http://localhost:3000',
      '/regles': 'http://localhost:3000',
      '/token': 'http://localhost:3000',
    },
  },
})
