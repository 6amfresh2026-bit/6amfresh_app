import { describe, it, expect } from 'vitest'
import {
  extractMenuCount,
  extractRestaurant,
  hasOutletAddress,
  checklistState,
  checklistPercent,
} from '../src/modules/Food/components/restaurant/sellerChecklist'

const menu = (sections) => ({ data: { data: { menu: { sections } } } })

describe('extractMenuCount', () => {
  it('counts items across the sections the seller menu endpoint really returns', () => {
    expect(extractMenuCount(menu([{ items: [{}, {}] }, { items: [{}] }, { items: [] }]))).toBe(3)
  })

  it('counts items nested in subsections too', () => {
    expect(extractMenuCount(menu([{ items: [{}], subsections: [{ items: [{}, {}] }] }]))).toBe(3)
  })

  it('reads a flat list or a total when that is what comes back', () => {
    expect(extractMenuCount({ data: { data: { items: [{}, {}] } } })).toBe(2)
    expect(extractMenuCount({ data: { data: { total: 7 } } })).toBe(7)
    expect(extractMenuCount({ data: { data: [{}, {}, {}] } })).toBe(3)
  })

  it('is zero for an empty menu, a missing response, or a failed call', () => {
    expect(extractMenuCount(menu([]))).toBe(0)
    expect(extractMenuCount(menu([{ name: 'Empty' }]))).toBe(0)
    expect(extractMenuCount(null)).toBe(0)
    expect(extractMenuCount(undefined)).toBe(0)
  })
})

describe('extractRestaurant', () => {
  it('finds the profile under any of the shapes the API has used', () => {
    expect(extractRestaurant({ data: { data: { restaurant: { id: 1 } } } })).toEqual({ id: 1 })
    expect(extractRestaurant({ data: { restaurant: { id: 2 } } })).toEqual({ id: 2 })
    expect(extractRestaurant(null)).toBeNull()
  })
})

describe('hasOutletAddress', () => {
  it('reads the address from location, where the profile puts it', () => {
    expect(hasOutletAddress({ location: { formattedAddress: '1 Road, Hyderabad' } })).toBe(true)
    expect(hasOutletAddress({ location: { addressLine1: 'Shop 4' } })).toBe(true)
  })

  it('still accepts a top-level address', () => {
    expect(hasOutletAddress({ addressLine1: 'Shop 4' })).toBe(true)
  })

  it('is false when there is no address anywhere', () => {
    expect(hasOutletAddress({ location: {} })).toBe(false)
    expect(hasOutletAddress({})).toBe(false)
    expect(hasOutletAddress(null)).toBe(false)
  })
})

describe('the checklist', () => {
  const complete = {
    location: { formattedAddress: 'x' },
    fssaiNumber: '12345678901234',
    zoneId: 'abc',
    accountNumber: '123',
    ifscCode: 'HDFC0001',
  }

  it('is 100% only when every step is done', () => {
    expect(checklistPercent(checklistState(complete, 5))).toBe(100)
  })

  it('needs both an address and an FSSAI number for the profile step', () => {
    expect(checklistState({ ...complete, fssaiNumber: '' }, 5).profile).toBe(false)
    expect(checklistState({ ...complete, location: {} }, 5).profile).toBe(false)
  })

  it('needs both an account number and an IFSC code for the bank step', () => {
    expect(checklistState({ ...complete, ifscCode: '' }, 5).bank).toBe(false)
    expect(checklistState({ ...complete, accountNumber: '' }, 5).bank).toBe(false)
  })

  it('treats a store with menu items and a zone but no profile or bank as 50%', () => {
    const state = checklistState({ zoneId: 'abc' }, 3)
    expect(state).toEqual({ profile: false, menu: true, zone: true, bank: false })
    expect(checklistPercent(state)).toBe(50)
  })

  it('is 0% for a brand-new store', () => {
    expect(checklistPercent(checklistState({ zoneId: '' }, 0))).toBe(0)
    expect(checklistPercent(checklistState(null, 0))).toBe(0)
  })
})
