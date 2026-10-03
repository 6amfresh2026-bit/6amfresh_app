// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { toSellerPath } from '../src/app/sellerRedirect'
import RedirectToSeller from '../src/app/RedirectToSeller'

afterEach(cleanup)

describe('toSellerPath', () => {
  it('rewrites the bare /restaurant prefix, which used to redirect to itself', () => {
    expect(toSellerPath('/restaurant/coupon')).toBe('/seller/coupon')
    expect(toSellerPath('/restaurant/orders/abc123')).toBe('/seller/orders/abc123')
    expect(toSellerPath('/restaurant')).toBe('/seller')
  })

  it('still rewrites the original /food/restaurant prefix', () => {
    expect(toSellerPath('/food/restaurant/login')).toBe('/seller/login')
    expect(toSellerPath('/food/restaurant')).toBe('/seller')
  })

  it('does not touch a different word that starts the same way', () => {
    expect(toSellerPath('/restaurants/demo')).toBe('/restaurants/demo')
    expect(toSellerPath('/restaurant-x/y')).toBe('/restaurant-x/y')
    expect(toSellerPath('/food/user/restaurants/demo')).toBe('/food/user/restaurants/demo')
  })

  it('leaves paths that are already seller paths alone, so it can never loop', () => {
    expect(toSellerPath('/seller/coupon')).toBe('/seller/coupon')
  })

  it('only rewrites the prefix, not a later segment', () => {
    expect(toSellerPath('/seller/restaurant/x')).toBe('/seller/restaurant/x')
  })

  it('tolerates empty and missing input', () => {
    expect(toSellerPath('')).toBe('')
    expect(toSellerPath()).toBe('')
  })
})

const Where = () => {
  const l = useLocation()
  return <div data-testid="where">{l.pathname + l.search + l.hash}</div>
}

const renderAt = (url) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/restaurant/*" element={<RedirectToSeller />} />
        <Route path="/food/restaurant/*" element={<RedirectToSeller />} />
        <Route path="/seller/*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )

describe('RedirectToSeller', () => {
  it('lands on the seller page instead of a blank screen', async () => {
    renderAt('/restaurant/coupon')
    expect((await screen.findByTestId('where')).textContent).toBe('/seller/coupon')
  })

  it('keeps the query string and the hash', async () => {
    renderAt('/food/restaurant/orders/42?tab=new#top')
    expect((await screen.findByTestId('where')).textContent).toBe('/seller/orders/42?tab=new#top')
  })
})
