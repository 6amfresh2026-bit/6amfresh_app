import { describe, expect, it } from 'vitest'
import { findItemByCode, matchesCode, receiptHtml } from '../src/modules/Food/components/restaurant/pos/posUtils.js'

const milk = { id: 'm1', name: 'Milk', barcode: '8901234567890', sku: 'MLK-1', itemCode: 'PRD0000000001', price: 28 }
const bread = { id: 'b1', name: 'Bread', barcode: '', sku: '', itemCode: 'PRD0000000002', price: 40 }

describe('finding the product a scan names', () => {
  it('matches on barcode, SKU or item code, ignoring case and spaces', () => {
    expect(findItemByCode([bread, milk], '8901234567890')).toBe(milk)
    expect(findItemByCode([bread, milk], ' mlk-1 ')).toBe(milk)
    expect(findItemByCode([bread, milk], 'prd0000000002')).toBe(bread)
  })

  it('finds nothing for a code no product has, or an empty scan', () => {
    expect(findItemByCode([bread, milk], '9999999999999')).toBeNull()
    expect(findItemByCode([bread, milk], '')).toBeNull()
    expect(findItemByCode([], '8901234567890')).toBeNull()
    expect(findItemByCode(undefined, '8901234567890')).toBeNull()
  })

  it('does not match on part of a code', () => {
    expect(matchesCode(milk, '890123456789')).toBe(false)
    expect(findItemByCode([milk], '8901')).toBeNull()
  })

  it('prefers a product that can be sold when two share a code', () => {
    const off = { ...milk, id: 'm0', isAvailable: false }
    expect(findItemByCode([off, milk], milk.barcode)).toBe(milk)
    // but still finds the unavailable one rather than reporting "no such product"
    expect(findItemByCode([off], milk.barcode)).toBe(off)
  })
})

describe('the printed bill', () => {
  const receipt = (items, over = {}) => ({
    billNo: 'POS-0007',
    createdAt: '2026-10-16T10:00:00Z',
    store: { name: 'Corner Store' },
    customer: { name: 'Walk in Customer', phone: '' },
    items,
    pricing: { subtotal: 68, total: 68 },
    payment: { tenders: [] },
    ...over,
  })
  const line = (over) => ({ name: 'Milk', quantity: 1, price: 28, amount: 28, ...over })
  const count = (html, re) => (html.match(re) || []).length

  it("prints each item's barcode under its line, with the number beside it", () => {
    const html = receiptHtml(receipt([line({ barcode: '4006381333931' }), line({ name: 'Bread', barcode: 'PRD0000000002' })]))
    expect(count(html, /class="ibc"/g)).toBe(2)
    expect(html).toContain('>4006381333931</span>')
    expect(html).toContain('>PRD0000000002</span>')
  })

  it('leaves out the barcode row for an item that has none', () => {
    const html = receiptHtml(receipt([line({ barcode: '' }), line({ name: 'Loose' })]))
    expect(count(html, /class="ibc"/g)).toBe(0)
  })

  it('still prints the bill-number barcode once, after the items', () => {
    const html = receiptHtml(receipt([line({ barcode: '4006381333931' })]))
    // 1 item barcode + 1 bill barcode
    expect(count(html, /<svg /g)).toBe(2)
    expect(html.lastIndexOf('<svg')).toBeGreaterThan(html.indexOf('class="ibc"'))
  })

  it('keeps a hold slip free of the bill barcode but still shows the item ones', () => {
    const html = receiptHtml(receipt([line({ barcode: '4006381333931' })]), { held: true })
    expect(count(html, /<svg /g)).toBe(1)
  })

  it('escapes a hostile barcode value', () => {
    const html = receiptHtml(receipt([line({ barcode: '<script>alert(1)</script>' })]))
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('&lt;script&gt;alert(1)')
  })
})
