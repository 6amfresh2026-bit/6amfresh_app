import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

// Kept apart from vite.config.js on purpose: the build config is scanned by the CI
// guard and should stay small. Aliases mirror it so source files import the same way.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const servicesApi = path.resolve(__dirname, './src/services/api')

export default defineConfig({
  // The app uses the automatic JSX runtime (no `import React`), so tests must too.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@food/api/axios': path.resolve(servicesApi, 'axios.js'),
      '@food/api/config': path.resolve(servicesApi, 'config.js'),
      '@food/api': servicesApi,
      '@food': path.resolve(__dirname, './src/modules/Food'),
      '@delivery': path.resolve(__dirname, './src/modules/DeliveryV2'),
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    include: ['tests/**/*.test.{js,jsx}'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      include: [
        'src/app/sellerRedirect.js',
        'src/app/RedirectToSeller.jsx',
        'src/modules/Food/components/restaurant/sellerChecklist.js',
        'src/modules/Food/pages/restaurant/couponValidation.js',
        'src/modules/DeliveryV2/utils/*.js',
      ],
    },
  },
})
