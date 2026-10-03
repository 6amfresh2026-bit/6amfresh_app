import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { typeOtp } from './helpers.js'

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:5173'
const ACCOUNTS = {
  admin: { email: 'admin@6am.com', password: 'password123' },
  seller: { phone: '9999900001' },
  rider: { phone: '9800000001' },
  customer: { phone: '7777777777' },
  otp: '1234',
}

/**
 * Logs in once per role through the real UI and saves the session, so each spec
 * starts already signed in. If a login screen is broken this fails here, loudly
 * and once, rather than as fifty unrelated timeouts.
 */
export default async function globalSetup() {
  mkdirSync('state', { recursive: true })
  const browser = await chromium.launch()
  const context = (extra = {}) =>
    browser.newContext({
      baseURL: BASE,
      geolocation: { latitude: 17.386, longitude: 78.4875 },
      permissions: ['geolocation'],
      ...extra,
    })

  const phoneLogin = async (name, loginPath, phoneSelector, submitName, landed) => {
    const ctx = await context()
    const page = await ctx.newPage()
    await page.goto(loginPath)
    await page.locator(phoneSelector).fill(ACCOUNTS[name].phone)
    await page.getByRole('button', { name: submitName }).click()
    await page.waitForURL(/otp/, { timeout: 20_000 })
    await typeOtp(page, ACCOUNTS.otp)
    await page.waitForURL(landed, { timeout: 30_000 })
    await ctx.storageState({ path: `state/${name}.json` })
    await ctx.close()
  }

  // Admin: email + password.
  {
    const ctx = await context()
    const page = await ctx.newPage()
    await page.goto('/admin/login')
    await page.getByPlaceholder('you@company.com').fill(ACCOUNTS.admin.email)
    await page.getByPlaceholder('••••••••').fill(ACCOUNTS.admin.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL(/\/admin\/store/, { timeout: 30_000 })
    await ctx.storageState({ path: 'state/admin.json' })
    await ctx.close()
  }

  await phoneLogin('seller', '/seller/login', 'input[type="tel"]', /Continue securely/i, /\/seller(\/|$)/)
  await phoneLogin('customer', '/food/user/auth/login', 'input[type="tel"]', /^Continue$/i, /\/food\/user(\/|$)/)
  await phoneLogin('rider', '/food/delivery/login', 'input[type="tel"]', /Go Online/i, /\/food\/delivery(\/|$)/)

  await browser.close()
}
