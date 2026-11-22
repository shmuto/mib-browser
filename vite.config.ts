import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { thirdPartyLicensesPlugin } from './scripts/third-party-licenses.mjs'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), thirdPartyLicensesPlugin()],
  base: '/mib-browser/',
})
