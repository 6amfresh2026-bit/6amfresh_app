import { test, expect } from '@playwright/test'
import { expectCleanPage } from '../helpers.js'

test.use({ storageState: 'state/seller.json' })

const ROUTES = [
  'dashboard',
  'notifications',
  'orders/all',
  'coupon',
  'delivery-settings',
  'delivery-fleet',
  'rush-hour',
  'menu-categories',
  'status',
  'explore',
  'outlet-timings',
  'outlet-info',
  'ratings-reviews',
  'edit-owner',
  'edit-cuisines',
  'edit-address',
  'inventory',
  'feedback',
  'dish-ratings',
  'help-centre/support',
  'fssai',
  'hub-finance',
  'subscription',
  'withdrawal-history',
  'finance-details',
  'manage-outlets',
  'update-bank-details',
  'zone-setup',
  'pos',
]

test.describe('seller panel', () => {
  test('live orders opens with the order tabs', async ({ page }) => {
    const text = await expectCleanPage(page, '/seller')
    expect(text).toMatch(/Live orders/i)
    expect(text).toMatch(/New Requests/i)
  })

  for (const route of ROUTES) {
    test(`/seller/${route} loads without errors`, async ({ page }) => {
      await expectCleanPage(page, `/seller/${route}`)
    })
  }

  test('"Getting Started" counts the seeded menu and zone (it sat at 0% when it read the wrong shapes)', async ({ page }) => {
    const text = await expectCleanPage(page, '/seller')
    const percent = Number((text.match(/Getting Started\s*(\d+)%/i) || [])[1])
    expect(percent, 'menu + zone are done, profile + bank are not').toBe(50)
  })

  test('the profile API reports the seller zone and store type', async ({ page, request }) => {
    await page.goto('/seller')
    const token = await page.evaluate(() => localStorage.getItem('restaurant_accessToken'))
    const api = process.env.E2E_API_URL || 'http://127.0.0.1:5000/api/v1'
    const res = await request.get(`${api}/food/restaurant/current`, { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status()).toBe(200)
    const profile = (await res.json()).data.restaurant
    expect(profile.zoneId, 'zoneId used to be dropped from this response').toBeTruthy()
    expect(profile.storeType).toBe('grocery')
  })
})

test.describe('regressions', () => {
  test('a bare /restaurant/... address redirects to /seller/... instead of a blank page', async ({ page }) => {
    await page.goto('/restaurant/coupon')
    await expect(page).toHaveURL(/\/seller\/coupon$/)
    await expect(page.getByRole('heading', { name: 'Offers & Coupons' })).toBeVisible()
  })

  test('a percentage coupon without a cap is explained, not rejected with a raw field name', async ({ page }) => {
    await page.goto('/seller/coupon/new')
    await page.getByPlaceholder('e.g. SAVE20').fill('E2ECAP')
    await page.getByPlaceholder('Enter amount').fill('10')
    await page.locator('input[type="date"]').nth(0).fill(new Date().toISOString().slice(0, 10))
    await page.locator('input[type="date"]').nth(1).fill('2099-12-31')
    await page.getByRole('button', { name: 'Create Coupon' }).click()

    await expect(page.getByText(/maximum discount/i).first()).toBeVisible()
    await expect(page.getByText('maxDiscount is required')).toHaveCount(0)
    await expect(page).toHaveURL(/\/seller\/coupon\/new/)
  })

  test('a coupon can be created, listed, and removed', async ({ page, request }) => {
    await page.goto('/seller/coupon/new')
    await page.getByPlaceholder('e.g. SAVE20').fill('E2ESAVE')
    await page.getByPlaceholder('Enter amount').fill('10')
    await page.getByPlaceholder('Max ₹ off').fill('50')
    await page.locator('input[type="date"]').nth(0).fill(new Date().toISOString().slice(0, 10))
    await page.locator('input[type="date"]').nth(1).fill('2099-12-31')
    await page.getByRole('button', { name: 'Create Coupon' }).click()

    await expect(page).toHaveURL(/\/seller\/coupon$/)
    await expect(page.getByText('E2ESAVE')).toBeVisible()

    const token = await page.evaluate(() => localStorage.getItem('restaurant_accessToken'))
    const api = process.env.E2E_API_URL || 'http://127.0.0.1:5000/api/v1'
    const headers = { Authorization: `Bearer ${token}` }
    const mine = await (await request.get(`${api}/food/restaurant/my-offers`, { headers })).json()
    const offer = mine.data.offers.find((o) => o.couponCode === 'E2ESAVE')
    expect(offer.maxDiscount).toBe(50)
    expect((await request.delete(`${api}/food/restaurant/my-offers/${offer._id}`, { headers })).status()).toBe(200)
  })

  test('a category can be created, renamed with a name-only update, and removed (what the menu rename now calls)', async ({ page, request }) => {
    await page.goto('/seller')
    const token = await page.evaluate(() => localStorage.getItem('restaurant_accessToken'))
    const api = (process.env.E2E_API_URL || 'http://127.0.0.1:5000/api/v1') + '/food/restaurant/categories'
    const headers = { Authorization: `Bearer ${token}` }

    const created = await request.post(api, { headers, data: { name: 'E2E Cat', dietType: 'veg', foodTypeScope: 'Veg' } })
    expect(created.status()).toBe(201)
    const id = (await created.json()).data.category._id

    const renamed = await request.patch(`${api}/${id}`, { headers, data: { name: 'E2E Cat Renamed' } })
    expect(renamed.status()).toBe(200)
    expect((await renamed.json()).data.category.name).toBe('E2E Cat Renamed')

    expect((await request.delete(`${api}/${id}`, { headers })).status()).toBe(200)
  })

  test('no screen still shows the old brand name', async ({ page }) => {
    for (const route of ['edit-owner', 'edit-address', 'finance-details']) {
      const text = await expectCleanPage(page, `/seller/${route}`, { minText: 10 })
      expect(text, `/seller/${route}`).not.toMatch(/Zomato/i)
    }
  })
})
