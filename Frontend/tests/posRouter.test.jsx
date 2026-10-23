// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

/**
 * The point of sale lives at /pos with its own sign-in, apart from the seller panel at /seller.
 * The real guards run here; the screens and the session are stand-ins.
 */
const session = { signedIn: false }

vi.mock('@food/utils/auth', () => ({
  isModuleAuthenticated: () => session.signedIn,
  ensureValidAccessToken: async () => (session.signedIn ? 'token' : null),
}))
vi.mock('@food/hooks/useRestaurantAppTheme', () => ({ default: () => {} }))
vi.mock('@food/components/Loader', () => ({ default: () => <div data-testid="loader" /> }))
vi.mock('@food/pages/restaurant/pos/PointOfSale', () => ({ default: () => <div data-testid="till" /> }))
vi.mock('@food/pages/restaurant/auth/Login', () => ({
  default: ({ flow }) => <div data-testid="login">{flow ? `${flow.loginPath}>${flow.otpPath}>${flow.homePath}` : 'seller-default'}</div>,
}))
vi.mock('@food/pages/restaurant/auth/Login', () => ({
  default: ({ flow }) => <div data-testid="owner-login">{flow ? `${flow.ownerLoginPath}>${flow.otpPath}>${flow.homePath}` : 'seller-default'}</div>,
}))
vi.mock('@food/pages/restaurant/auth/OTP', () => ({
  default: ({ flow }) => <div data-testid="otp">{flow ? flow.homePath : 'seller-default'}</div>,
}))
vi.mock('@food/pages/restaurant/auth/PosLogin', () => ({
  default: ({ flow }) => <div data-testid="pos-login">{flow ? `${flow.loginPath}>${flow.homePath}` : 'none'}</div>,
}))
vi.mock('@food/components/restaurant/RestaurantLayout', () => ({ default: ({ children }) => <div>{children}</div> }))

import PosRouter from '../src/modules/Pos/PosRouter'
import RestaurantRouter from '../src/modules/Food/components/restaurant/RestaurantRouter'
import { POS_FLOW, SELLER_FLOW } from '../src/modules/Food/utils/sellerAuthFlow'

const Where = () => {
  const l = useLocation()
  return <div data-testid="where">{l.pathname}</div>
}

const renderAt = (url) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/pos/*" element={<PosRouter />} />
        <Route path="/seller/*" element={<RestaurantRouter />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  )

beforeEach(() => {
  session.signedIn = false
})
afterEach(cleanup)

describe('the sign-in flows', () => {
  it('keep the seller panel and the till apart', () => {
    expect(SELLER_FLOW.homePath).toBe('/seller')
    expect(SELLER_FLOW.loginPath).toBe('/seller/login')
    expect(POS_FLOW.homePath).toBe('/pos')
    expect(POS_FLOW.loginPath).toBe('/pos/login')
    // every POS path is under /pos, none under /seller
    for (const p of [POS_FLOW.homePath, POS_FLOW.loginPath]) expect(p.startsWith('/pos')).toBe(true)
  })
})

describe('/pos', () => {
  it('sends someone who is not signed in to the POS login, not the seller login', async () => {
    renderAt('/pos')
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/pos/login'))
    expect(await screen.findByTestId('pos-login')).toBeTruthy()
  })

  it('opens the till for a signed-in store', async () => {
    session.signedIn = true
    renderAt('/pos')
    expect(await screen.findByTestId('till')).toBeTruthy()
    expect(screen.getByTestId('where').textContent).toBe('/pos')
  })

  it('shows the username and password sign-in with the POS flow, so it comes back to /pos', async () => {
    renderAt('/pos/login')
    expect((await screen.findByTestId('pos-login')).textContent).toBe('/pos/login>/pos')
  })

  it('lets the store owner sign in with phone + OTP, coming back to /pos', async () => {
    renderAt('/pos/owner-login')
    expect((await screen.findByTestId('owner-login')).textContent).toBe('/pos/owner-login>/pos/otp>/pos')
    cleanup()
    renderAt('/pos/otp')
    expect((await screen.findByTestId('otp')).textContent).toBe('/pos')
  })

  it('moves a signed-in store off the login pages and into the till', async () => {
    session.signedIn = true
    renderAt('/pos/login')
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/pos'))
    expect(await screen.findByTestId('till')).toBeTruthy()
  })

  it('sends an unknown address under /pos back to the till', async () => {
    session.signedIn = true
    renderAt('/pos/whatever/else')
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/pos'))
  })
})

describe('the old seller address', () => {
  it('/seller/pos goes to /pos', async () => {
    session.signedIn = true
    renderAt('/seller/pos')
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/pos'))
    expect(await screen.findByTestId('till')).toBeTruthy()
  })

  it('/seller/pos goes to /pos for someone signed out, who then meets the POS login', async () => {
    renderAt('/seller/pos')
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/pos/login'))
  })
})
