import { describe, expect, it } from 'vitest'
import {
  LABEL_LAYOUTS,
  MAX_COPIES,
  MAX_LABELS,
  buildLabel,
  expandCopies,
  formatDate,
  getLayout,
  humanCode,
  labelSheetHtml,
  labelsPerPage,
  pageGeometry,
  paginate,
} from '../src/modules/Food/utils/labelLayout.js'
import { buildLabelsPdf } from '../src/modules/Food/utils/labelPdf.js'
import { encodeBars } from '../src/modules/Food/utils/barcode.js'

const row = (over = {}) => ({ name: 'Coffee', unit: '200 g', barcode: '2900000000087', price: 210, mrp: 240, expiryDate: '2027-03-09', ...over })
const NOW = new Date(2026, 9, 22) // 22 Oct 2026
const label = (over = {}, opts = {}) => buildLabel(row(over), opts, NOW)
const count = (s, re) => (s.match(re) || []).length

describe('layouts', () => {
  it('fits the labels the sheet says it holds, on an A4 page', () => {
    for (const l of LABEL_LAYOUTS.filter((x) => x.kind === 'sheet')) {
      const g = pageGeometry(l)
      expect(l.cols * l.widthMm + 2 * g.marginXMm).toBeCloseTo(210, 5)
      expect(l.rows * l.heightMm + 2 * g.marginYMm).toBeCloseTo(297, 5)
      expect(g.marginXMm).toBeGreaterThanOrEqual(0)
      expect(g.marginYMm).toBeGreaterThanOrEqual(0)
    }
  })

  it('knows the common sheets by their label counts', () => {
    expect(labelsPerPage(getLayout('a4-24'))).toBe(24)
    expect(labelsPerPage(getLayout('a4-40'))).toBe(40)
    expect(labelsPerPage(getLayout('a4-65'))).toBe(65)
    expect(labelsPerPage(getLayout('roll-50x30'))).toBe(1)
  })

  it('the 24-up sheet has no side margin (70 mm x 3 = the page width)', () => {
    const g = pageGeometry(getLayout('a4-24'))
    expect(g.marginXMm).toBe(0)
    expect(g.marginYMm).toBeCloseTo(0.5, 5)
  })

  it('a roll label is its own page', () => {
    const g = pageGeometry(getLayout('roll-38x25'))
    expect([g.pageWidthMm, g.pageHeightMm, g.marginXMm, g.marginYMm]).toEqual([38, 25, 0, 0])
  })

  it('falls back to the first layout for an unknown id', () => {
    expect(getLayout('nope').id).toBe('a4-24')
  })
})

describe('label content', () => {
  it('has the price and a struck MRP when MRP is above the price', () => {
    const l = label()
    expect(l.priceText).toBe('₹210')
    expect(l.mrpText).toBe('MRP ₹240')
    expect(l.mrpStruck).toBe(true)
    expect(l.human).toBe('2 900000 000087')
  })

  it('shows no MRP when it is not above the price', () => {
    expect(label({ mrp: 210 }).mrpText).toBe('')
    expect(label({ mrp: 150 }).mrpText).toBe('')
    expect(label({ mrp: null }).mrpText).toBe('')
  })

  it('honours the price and MRP switches', () => {
    expect(label({}, { showPrice: false }).priceText).toBe('')
    expect(label({}, { showMrp: false }).mrpText).toBe('')
  })

  it('shows MRP as the price, not struck, when the selling price is hidden', () => {
    const l = label({}, { showPrice: false })
    expect(l.mrpText).toBe('MRP ₹240')
    expect(l.mrpStruck).toBe(false)
  })

  it('shows paise to two places and drops a trailing .00', () => {
    expect(label({ price: 99.5 }).priceText).toBe('₹99.50')
    expect(label({ price: 100 }).priceText).toBe('₹100')
    expect(label({ price: 10.25 }).priceText).toBe('₹10.25')
  })

  it('prints packed and expiry dates only when asked', () => {
    expect(label().packed).toBe('')
    expect(label().expiry).toBe('')
    const l = label({}, { packed: true, expiry: true })
    expect(l.packed).toBe('22/10/2026')
    expect(l.expiry).toBe('09/03/2027')
  })

  it('leaves the expiry blank for a product that has none', () => {
    expect(label({ expiryDate: null }, { expiry: true }).expiry).toBe('')
    expect(formatDate('not a date')).toBe('')
  })

  it('skips a product with no barcode', () => {
    expect(label({ barcode: '' })).toBeNull()
    expect(label({ barcode: '   ' })).toBeNull()
  })

  it('limits and defaults the copy count', () => {
    expect(label({ copies: 3 }).copies).toBe(3)
    expect(label({ copies: 0 }).copies).toBe(1)
    expect(label({ copies: 'abc' }).copies).toBe(1)
    expect(label({ copies: 9999 }).copies).toBe(MAX_COPIES)
  })

  it('groups an EAN-13 for reading and leaves other codes alone', () => {
    expect(humanCode('4006381333931')).toBe('4 006381 333931')
    expect(humanCode('PRD0000000042')).toBe('PRD0000000042')
  })
})

describe('pages', () => {
  it('repeats labels by copies and caps the total', () => {
    expect(expandCopies([label({ copies: 3 }), label({ copies: 2 })])).toHaveLength(5)
    expect(expandCopies(Array.from({ length: 10 }, () => label({ copies: 500 })))).toHaveLength(MAX_LABELS)
  })

  it('fills a sheet before starting the next', () => {
    const flat = expandCopies([label({ copies: 50 })])
    expect(paginate(flat, getLayout('a4-24')).map((p) => p.length)).toEqual([24, 24, 2])
    expect(paginate(flat, getLayout('a4-65')).map((p) => p.length)).toEqual([50])
    expect(paginate(flat, getLayout('roll-50x30'))).toHaveLength(50)
    expect(paginate([], getLayout('a4-24'))).toEqual([])
  })
})

describe('the printable document', () => {
  const sheet = (n, opts) => labelSheetHtml(expandCopies([label({ copies: n })]), getLayout('a4-24'), opts)

  it('sets the page to A4 and the grid to 3 columns', () => {
    const html = sheet(1)
    expect(html).toContain('@page{size:210mm 297mm;margin:0}')
    expect(html).toContain('grid-template-columns:repeat(3,70mm)')
    expect(html).toContain('grid-auto-rows:37mm')
  })

  it('puts 24 labels on a page and breaks to the next', () => {
    const html = sheet(30)
    expect(count(html, /class="page"/g)).toBe(2)
    expect(count(html, /class="cell"/g)).toBe(30)
  })

  it('draws cut guides only when asked', () => {
    expect(sheet(1)).not.toContain('outline:.2mm dashed')
    expect(sheet(1, { guides: true })).toContain('outline:.2mm dashed')
  })

  it('prints on open only when asked', () => {
    expect(sheet(1)).toContain('window.print()')
    expect(sheet(1, { autoPrint: false })).not.toContain('window.print()')
  })

  it('makes each roll label its own page of the label size', () => {
    const html = labelSheetHtml(expandCopies([label({ copies: 3 })]), getLayout('roll-50x30'))
    expect(html).toContain('@page{size:50mm 30mm;margin:0}')
    expect(count(html, /class="page"/g)).toBe(3)
  })

  it('uses a stretched barcode so the bars fill the label', () => {
    expect(sheet(1)).toContain('preserveAspectRatio="none"')
  })

  it('escapes product names and dates', () => {
    const html = labelSheetHtml([label({ name: '<img src=x onerror=alert(1)>', unit: '"><b>' })], getLayout('a4-24'))
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('"><b>')
    expect(html).toContain('&lt;img src=x')
  })

  it('shows the price, the struck MRP and the pack size', () => {
    const html = sheet(1)
    expect(html).toContain('₹210')
    expect(html).toContain('<s>MRP ₹240</s>')
    expect(html).toContain('200 g')
    expect(html).toContain('2 900000 000087')
  })
})

describe('the PDF', () => {
  it('has one page per sheet', async () => {
    const flat = expandCopies([label({ copies: 50 })])
    const doc = await buildLabelsPdf(flat, getLayout('a4-24'))
    expect(doc.getNumberOfPages()).toBe(3)
  })

  it('has one page per roll label, sized to the label', async () => {
    const flat = expandCopies([label({ copies: 4 })])
    const doc = await buildLabelsPdf(flat, getLayout('roll-50x30'))
    expect(doc.getNumberOfPages()).toBe(4)
    const size = doc.internal.pageSize
    expect(Math.round(size.getWidth())).toBe(50)
    expect(Math.round(size.getHeight())).toBe(30)
  })

  it('draws the real bars: one filled rectangle per bar, for every label', async () => {
    const flat = expandCopies([label({ copies: 2 })])
    const doc = await buildLabelsPdf(flat, getLayout('a4-24'), { compress: false })
    const text = Buffer.from(doc.output('arraybuffer')).toString('latin1')
    const bars = encodeBars('2900000000087').bars.length
    expect(count(text, / re\nf\n/g)).toBe(bars * 2)
  })

  it('writes the rupee as Rs and never emits a character the font cannot show', async () => {
    const flat = [label({ name: 'Chai ☕ पत्ती' })]
    const doc = await buildLabelsPdf(flat, getLayout('a4-24'), { compress: false })
    const text = Buffer.from(doc.output('arraybuffer')).toString('latin1')
    expect(text).toContain('Rs 210')
    expect(text).not.toContain('₹')
    expect(text).toContain('Chai ?')
  })

  it('produces a real PDF', async () => {
    const doc = await buildLabelsPdf([label()], getLayout('a4-65'))
    const bytes = Buffer.from(doc.output('arraybuffer'))
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(500)
  })
})
