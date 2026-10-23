import { describe, it, expect } from 'vitest'
import { createLineBuffer, isWeighedItem, parseScaleLine } from '../src/modules/Food/components/restaurant/pos/scaleParser.js'

describe('what a scale sends', () => {
  it('reads the usual formats as kilograms', () => {
    expect(parseScaleLine('ST,GS,   1.250 kg')).toEqual({ kg: 1.25, stable: true })
    expect(parseScaleLine('+001.250kg')).toEqual({ kg: 1.25, stable: true })
    expect(parseScaleLine('  0.500 g')).toEqual({ kg: 0.001, stable: true })
    expect(parseScaleLine('500 g').kg).toBe(0.5)
    expect(parseScaleLine('2.2 lb').kg).toBe(0.998)
  })

  it('uses the unit set on the till when the scale sends only a number', () => {
    expect(parseScaleLine('1.250', 'kg').kg).toBe(1.25)
    expect(parseScaleLine('750', 'g').kg).toBe(0.75)
  })

  it('knows an unstable reading', () => {
    expect(parseScaleLine('US,GS,   1.180 kg')).toEqual({ kg: 1.18, stable: false })
    expect(parseScaleLine('ST,GS,   1.180 kg').stable).toBe(true)
  })

  it('ignores blank and non-weight lines, and never goes negative', () => {
    expect(parseScaleLine('')).toBeNull()
    expect(parseScaleLine('   ')).toBeNull()
    expect(parseScaleLine('ERR')).toBeNull()
    expect(parseScaleLine('-0.020 kg').kg).toBe(0)
  })
})

describe('the serial line buffer', () => {
  it('hands out whole lines, however the chunks fall', () => {
    const got = []
    const feed = createLineBuffer((l) => got.push(l))
    feed('ST,GS, 1.2')
    expect(got).toEqual([])
    feed('50 kg\r\nST,GS, 1.251 kg\r')
    feed('\nST,GS, 1.2')
    expect(got).toEqual(['ST,GS, 1.250 kg', 'ST,GS, 1.251 kg'])
  })

  it('does not grow forever when a scale never ends a line', () => {
    const got = []
    const feed = createLineBuffer((l) => got.push(l))
    for (let i = 0; i < 100; i++) feed('1234567890')
    feed('\n')
    expect(got.length).toBe(1)
    expect(got[0].length).toBeLessThanOrEqual(200)
  })
})

describe('which products are weighed', () => {
  it('is the flagged ones, and anything priced per kg or g', () => {
    expect(isWeighedItem({ soldByWeight: true })).toBe(true)
    expect(isWeighedItem({ unit: 'kg' })).toBe(true)
    expect(isWeighedItem({ unit: 'Gm' })).toBe(true)
    expect(isWeighedItem({ packSize: '1 kg' })).toBe(false)
    expect(isWeighedItem({ unit: 'pcs' })).toBe(false)
    expect(isWeighedItem({})).toBe(false)
  })
})
