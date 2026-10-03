import { test, expect } from '@playwright/test'
import { expectCleanPage } from '../helpers.js'

test.describe('rider app', () => {
  test.use({ storageState: 'state/rider.json' })

  test('the home screen opens signed in, with the online switch', async ({ page }) => {
    const text = await expectCleanPage(page, '/food/delivery')
    expect(text).toMatch(/ONLINE|OFFLINE/)
    expect(text).not.toMatch(/INFINITY/i)
  })

  for (const route of ['history', 'pocket', 'profile']) {
    test(`/food/delivery/${route} loads without errors`, async ({ page }) => {
      await expectCleanPage(page, `/food/delivery/${route}`)
    })
  }

  test('the API answers "no current trip" as null, not an error', async ({ page, request }) => {
    await page.goto('/food/delivery')
    const token = await page.evaluate(() => localStorage.getItem('delivery_accessToken'))
    const api = process.env.E2E_API_URL || 'http://127.0.0.1:5000/api/v1'
    const res = await request.get(`${api}/food/delivery/orders/current`, { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status()).toBe(200)
    expect((await res.json()).data.activeOrder ?? null).toBeNull()
  })
})

test.describe('customer app', () => {
  test.use({ storageState: 'state/customer.json' })

  test('the home screen opens signed in', async ({ page }) => {
    const text = await expectCleanPage(page, '/food/user')
    expect(text.length).toBeGreaterThan(50)
  })

  test('the cart is reachable and says it is empty', async ({ page }) => {
    const text = await expectCleanPage(page, '/food/user/cart')
    expect(text).toMatch(/empty/i)
  })

  test('the public restaurant list includes the seeded store for its own zone', async ({ request }) => {
    const api = process.env.E2E_API_URL || 'http://127.0.0.1:5000/api/v1'
    const zones = await (await request.get(`${api}/food/zones/detect?lat=17.385&lng=78.4867`)).json()
    expect(zones.data.status).toBe('IN_SERVICE')

    const res = await request.get(`${api}/food/restaurant/restaurants?zoneId=${zones.data.zoneId}&lat=17.385&lng=78.4867`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    const names = body.data.restaurants.map((r) => r.restaurantName)
    expect(names).toContain('E2E Store')
  })

  test('unified search answers for a signed-out visitor', async ({ request }) => {
    const api = process.env.E2E_API_URL || 'http://127.0.0.1:5000/api/v1'
    const res = await request.get(`${api}/food/search/unified?q=milk`)
    expect(res.status()).toBe(200)
  })

  test('a location outside every zone is reported out of service', async ({ request }) => {
    const api = process.env.E2E_API_URL || 'http://127.0.0.1:5000/api/v1'
    const res = await request.get(`${api}/food/zones/detect?lat=28.6&lng=77.2`)
    expect((await res.json()).data.status).toBe('OUT_OF_SERVICE')
  })
})

test.describe('signed out', () => {
  test('every app sends an unauthenticated visitor to its own login', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: undefined })
    const page = await ctx.newPage()
    for (const [path, login] of [
      ['/admin/store', /\/admin\/login/],
      ['/seller/dashboard', /\/seller\/(login|welcome)/],
      ['/food/delivery/profile', /\/food\/delivery\/(login|welcome)/],
    ]) {
      await page.goto(path)
      await expect(page, path).toHaveURL(login, { timeout: 15_000 })
    }
    await ctx.close()
  })
})
