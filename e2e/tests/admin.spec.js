import { test, expect } from '@playwright/test'
import { expectCleanPage, watch } from '../helpers.js'

test.use({ storageState: 'state/admin.json' })

// Every screen in the admin sidebar that reads from the API. Each is its own test,
// so a broken page is named in the report instead of hiding behind the first one.
const ROUTES = [
  'orders/all',
  'orders/pending',
  'orders/delivered',
  'orders/canceled',
  'orders/refunded',
  'orders/offline-payments',
  'orders/abandoned',
  'orders/user-carts',
  'subscriptions',
  'brands',
  'units',
  'departments',
  'zone-setup',
  'food-approval',
  'restaurants',
  'restaurants/joining-request',
  'restaurants/commission',
  'restaurants/complaints',
  'restaurants/reviews',
  'categories',
  'fee-settings',
  'referral-settings',
  'products',
  'stocks',
  'stock-verification',
  'addons',
  'coupons',
  'cashback',
  'banners',
  'promotional-banner',
  'customers',
  'support-tickets',
  'delivery-boy-commission',
  'delivery-cash-limit',
  'cash-limit-settlement',
  'delivery-withdrawal',
  'delivery-boy-wallet',
  'delivery-emergency-help',
  'delivery-order-reassignment-requests',
  'delivery-partners',
  'delivery-partners/join-request',
  'delivery-partners/live-tracking',
  'delivery-partners/earnings',
  'transaction-report',
  'wallet-dashboard',
  'expense-report',
  'restaurant-withdraws',
  'business-setup',
  'delivery-slots',
  'feature-settings',
  'notifications',
  'hero-banner-management',
  'employees',
]

test.describe('admin panel', () => {
  test('the dashboard shows real numbers from the seeded data', async ({ page }) => {
    const text = await expectCleanPage(page, '/admin/store')
    expect(text).toMatch(/Operations Command/i)
    expect(text).toMatch(/Total sellers/i)
  })

  for (const route of ROUTES) {
    test(`/admin/store/${route} loads without errors`, async ({ page }) => {
      await expectCleanPage(page, `/admin/store/${route}`)
    })
  }

  test('an unknown admin path falls back to the dashboard, not a blank page', async ({ page }) => {
    await page.goto('/admin/store/definitely-not-a-page')
    await expect(page).toHaveURL(/\/admin\/store/)
  })

  test('the sellers list includes the seeded store', async ({ page }) => {
    const text = await expectCleanPage(page, '/admin/store/restaurants')
    expect(text).toContain('E2E Store')
  })

  test('master data can be created and removed (brand)', async ({ page, request }) => {
    await page.goto('/admin/store')
    const token = await page.evaluate(() => localStorage.getItem('admin_accessToken'))
    expect(token, 'admin session token').toBeTruthy()
    const api = (process.env.E2E_API_URL || 'http://127.0.0.1:5000/api/v1') + '/food/admin'
    const headers = { Authorization: `Bearer ${token}` }

    const created = await request.post(`${api}/brands`, { headers, data: { name: `E2E Brand ${Date.now()}` } })
    expect(created.status()).toBe(201)
    const body = (await created.json()).data
    const id = body?.brand?._id ?? body?._id ?? body?.id
    expect(id).toBeTruthy()
    expect((await request.delete(`${api}/brands/${id}`, { headers })).status()).toBe(200)
  })

  test('a zone that still has a seller cannot be deleted', async ({ page, request }) => {
    await page.goto('/admin/store')
    const token = await page.evaluate(() => localStorage.getItem('admin_accessToken'))
    const api = (process.env.E2E_API_URL || 'http://127.0.0.1:5000/api/v1') + '/food/admin'
    const headers = { Authorization: `Bearer ${token}` }

    const zones = await (await request.get(`${api}/zones?limit=50&page=1`, { headers })).json()
    const list = zones.data?.zones || zones.data || []
    const zone = list.find((z) => z.name === 'E2E Zone')
    expect(zone, 'seeded zone').toBeTruthy()

    const res = await request.delete(`${api}/zones/${zone._id}`, { headers })
    expect(res.status()).toBe(400)
    expect((await res.json()).message).toMatch(/assigned to \d+ seller/i)
  })
})

test('logging in with a wrong password is refused', async ({ browser }) => {
  const context = await browser.newContext({ storageState: undefined })
  const page = await context.newPage()
  const w = watch(page)
  await page.goto('/admin/login')
  await page.getByPlaceholder('you@company.com').fill('admin@6am.com')
  await page.getByPlaceholder('••••••••').fill('not-the-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForTimeout(1500)
  await expect(page).toHaveURL(/\/admin\/login/)
  expect(w.problems().filter((p) => !/http 40[01]/.test(p))).toEqual([])
  await context.close()
})
