import { describe, it, expect } from 'vitest'
import {
  formatLastLogin,
  generatePassword,
  userProblem,
} from '../src/modules/Food/pages/admin/posusers/posUsersUtils.js'

const ok = { restaurantId: 's1', name: 'Asha Kumar', username: 'asha.k', password: 'secret123' }

describe('POS user form', () => {
  it('is fine when everything is filled in', () => {
    expect(userProblem(ok)).toBe('')
  })

  it('says what is missing, in the order the form is read', () => {
    expect(userProblem({ ...ok, restaurantId: '' })).toMatch(/store/)
    expect(userProblem({ ...ok, name: '  ' })).toMatch(/name/)
    expect(userProblem({ ...ok, username: 'a b' })).toMatch(/Username/)
    expect(userProblem({ ...ok, username: 'ab' })).toMatch(/Username/)
    expect(userProblem({ ...ok, password: '12345' })).toMatch(/at least 6/)
  })

  it('treats the username case-insensitively, as the server does', () => {
    expect(userProblem({ ...ok, username: 'Asha.K' })).toBe('')
  })

  it('does not need a password or a store when editing', () => {
    expect(userProblem({ name: 'Asha', username: 'valid', password: '' }, { needPassword: false, needStore: false })).toBe('')
  })
})

describe('generated passwords', () => {
  it('are 10 characters, pass the form check and are not repeated', () => {
    const a = generatePassword()
    const b = generatePassword()
    expect(a).toHaveLength(10)
    expect(userProblem({ ...ok, password: a })).toBe('')
    expect(a).not.toBe(b)
  })

  it('leave out the look-alike characters', () => {
    for (let i = 0; i < 50; i++) expect(generatePassword(20)).not.toMatch(/[0O1lI]/)
  })
})

describe('last sign-in', () => {
  it('says Never for nothing or rubbish', () => {
    expect(formatLastLogin(null)).toBe('Never')
    expect(formatLastLogin('not a date')).toBe('Never')
  })
  it('shows a date for a real time', () => {
    expect(formatLastLogin('2026-10-22T09:30:00Z')).not.toBe('Never')
  })
})

import { RANGES, money, modeLabel, rangeParams, statusTone } from '../src/modules/Food/pages/admin/posusers/posUsersUtils.js'

describe('tracking helpers', () => {
  it('formats money with paise only when there are some', () => {
    expect(money(1234)).toBe('₹1,234')
    expect(money(99.5)).toBe('₹99.50')
    expect(money(0)).toBe('₹0')
    expect(money(-50)).toBe('-₹50')
    expect(money(null)).toBe('₹0')
  })

  it('names payment modes and colours bill statuses', () => {
    expect(modeLabel('pay_later')).toBe('Pay later')
    expect(modeLabel('upi')).toBe('UPI')
    expect(modeLabel('gift_card')).toBe('gift card')
    expect(modeLabel('')).toBe('—')
    expect(statusTone('delivered')).toBe('green')
    expect(statusTone('cancelled_by_restaurant')).toBe('red')
    expect(statusTone('created')).toBe('gray')
  })

  it('turns a range into whole calendar days ending today', () => {
    const now = new Date(2026, 9, 22, 15, 0)
    expect(rangeParams('today', now)).toEqual({ from: '2026-10-22', to: '2026-10-22' })
    expect(rangeParams('7d', now)).toEqual({ from: '2026-10-16', to: '2026-10-22' })
    expect(rangeParams('30d', now).from).toBe('2026-09-23')
    expect(rangeParams('nonsense', now).from).toBe('2026-09-23')
    expect(RANGES.map(([k]) => k)).toEqual(['today', '7d', '30d', '90d'])
  })
})
