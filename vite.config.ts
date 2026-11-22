import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { thirdPartyLicensesPlugin } from './scripts/third-party-licenses.mjs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), thirdPartyLicensesPlugin()],
  base: '/mib-browser/',
})
