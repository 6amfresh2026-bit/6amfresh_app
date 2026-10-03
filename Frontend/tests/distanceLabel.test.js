import { describe, it, expect } from 'vitest'
import { formatKmToTarget } from '../src/modules/DeliveryV2/utils/distanceLabel'
import { formatDistanceLabel } from '../src/modules/Food/utils/roadDistance'

describe('formatKmToTarget (rider pickup card)', () => {
  it('shows kilometres to one decimal', () => {
    expect(formatKmToTarget(1234)).toBe('1.2')
    expect(formatKmToTarget(0)).toBe('0.0')
  })

  it('shows -- instead of INFINITY before a GPS fix', () => {
    expect(formatKmToTarget(Infinity)).toBe('--')
    expect(formatKmToTarget(NaN)).toBe('--')
    expect(formatKmToTarget(undefined)).toBe('--')
    expect(formatKmToTarget(null)).toBe('--')
  })
})

describe('formatDistanceLabel (offer card)', () => {
  it('uses km from one kilometre up, metres below it', () => {
    expect(formatDistanceLabel(13.09)).toBe('13.1 km')
    expect(formatDistanceLabel(1)).toBe('1.0 km')
    expect(formatDistanceLabel(0.45)).toBe('450 m')
  })

  it('returns null for anything that is not a number, so the caller can fall back', () => {
    expect(formatDistanceLabel(null)).toBeNull()
    expect(formatDistanceLabel(undefined)).toBeNull()
    expect(formatDistanceLabel(NaN)).toBeNull()
  })
})
