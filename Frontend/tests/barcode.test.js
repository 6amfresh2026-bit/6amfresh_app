import { describe, expect, it } from 'vitest'
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library'
import {
  barcodeSvg,
  encodeBars,
  isValidEan13,
  labelsHtml,
  withEan13CheckDigit,
} from '../src/modules/Food/utils/barcode.js'

/**
 * Drawing a barcode is only worth anything if a scanner reads it back. So these draw
 * the bars into a pixel grid and decode that with zxing - the same library the camera
 * scanner uses, written independently of the encoder - and expect the same text.
 */
const decode = (text, { scale = 3, rows = 24, quietModules = 10 } = {}) => {
  const encoded = encodeBars(text)
  const width = (encoded.width + quietModules * 2) * scale
  const pixels = new Uint8ClampedArray(width * rows).fill(255)
  for (const bar of encoded.bars) {
    for (let x = (bar.x + quietModules) * scale; x < (bar.x + bar.w + quietModules) * scale; x += 1) {
      for (let y = 0; y < rows; y += 1) pixels[y * width + x] = 0
    }
  }
  const reader = new MultiFormatReader()
  reader.setHints(
    new Map([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.CODE_128]]]),
  )
  const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels, width, rows)))
  const result = reader.decode(bitmap)
  return { text: result.getText(), format: result.getBarcodeFormat() }
}

describe('EAN-13 check digit', () => {
  it('accepts real barcodes and rejects a wrong check digit', () => {
    for (const ok of ['4006381333931', '5901234123457', '9780201379624']) expect(isValidEan13(ok)).toBe(true)
    for (const bad of ['4006381333932', '5901234123450', '400638133393', '40063813339311', 'abcdefghijklm', '']) {
      expect(isValidEan13(bad)).toBe(false)
    }
  })

  it('completes twelve digits', () => {
    expect(withEan13CheckDigit('400638133393')).toBe('4006381333931')
    expect(withEan13CheckDigit('590123412345')).toBe('5901234123457')
    expect(() => withEan13CheckDigit('12345')).toThrow()
  })
})

describe('encodeBars', () => {
  it('uses EAN-13 for a valid 13-digit code, 95 modules wide', () => {
    const e = encodeBars('4006381333931')
    expect(e.format).toBe('ean13')
    expect(e.width).toBe(95)
  })

  it('falls back to Code 128 for anything else, including 13 digits with a wrong check digit', () => {
    expect(encodeBars('PRD0000000042').format).toBe('code128')
    expect(encodeBars('4006381333932').format).toBe('code128')
    expect(encodeBars('123456').format).toBe('code128')
  })

  it('has nothing to draw for an empty value', () => {
    expect(encodeBars('')).toBeNull()
    expect(encodeBars(null)).toBeNull()
    expect(barcodeSvg('')).toBe('')
  })
})

describe('round trip through an independent decoder', () => {
  it('reads EAN-13 back, including the ones this app generates', () => {
    const generated = ['290000000001', '290000012345', '299999999999', '200000000000'].map(withEan13CheckDigit)
    for (const code of ['4006381333931', '5901234123457', '9780201379624', ...generated]) {
      const out = decode(code)
      expect(out.text).toBe(code)
      expect(out.format).toBe(BarcodeFormat.EAN_13)
    }
  })

  it('reads Code 128 back, for bill numbers and item codes', () => {
    for (const code of ['PRD0000000042', 'POS-20261016-0007', 'abc xyz 123', 'A', '12345', '9000000101']) {
      const out = decode(code)
      expect(out.text).toBe(code)
      expect(out.format).toBe(BarcodeFormat.CODE_128)
    }
  })

  it('still reads at the small size a receipt line uses', () => {
    const ean = withEan13CheckDigit('290000000001')
    expect(decode(ean, { scale: 2 }).text).toBe(ean)
    expect(decode('PRD0000000042', { scale: 2 }).text).toBe('PRD0000000042')
  })
})

describe('barcodeSvg', () => {
  it('is an svg with a bar per element and a quiet zone', () => {
    const svg = barcodeSvg('4006381333931', { module: 2, height: 30 })
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('viewBox="-20.00 0')
    expect((svg.match(/<rect /g) || []).length).toBe(encodeBars('4006381333931').bars.length)
  })

  it('can print the value under the bars, escaped', () => {
    expect(barcodeSvg('A<B', { showText: true })).toContain('A&lt;B</text>')
    expect(barcodeSvg('4006381333931')).not.toContain('<text')
  })
})

describe('labelsHtml', () => {
  const label = (over = {}) => ({ name: 'Amul Milk', barcode: '4006381333931', price: 28, mrp: 30, copies: 1, ...over })

  it('prints one label per copy', () => {
    const html = labelsHtml([label({ copies: 3 }), label({ name: 'Bread', barcode: 'PRD1', copies: 2 })])
    expect((html.match(/class="label"/g) || []).length).toBe(5)
  })

  it('skips a product without a barcode rather than printing a label that cannot scan', () => {
    const html = labelsHtml([label({ barcode: '' }), label({ name: 'Bread', barcode: 'PRD1' })])
    expect((html.match(/class="label"/g) || []).length).toBe(1)
    expect(html).not.toContain('Amul Milk')
  })

  it('escapes product names', () => {
    const html = labelsHtml([label({ name: '<img src=x onerror=alert(1)>' })])
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })

  it('shows MRP struck through only when it is above the selling price', () => {
    expect(labelsHtml([label()])).toContain('<s>MRP')
    expect(labelsHtml([label({ mrp: 28 })])).not.toContain('<s>MRP')
  })

  it('sizes the page to the label and caps absurd copy counts', () => {
    const html = labelsHtml([label({ copies: 99999 })], { widthMm: 38, heightMm: 25 })
    expect(html).toContain('size: 38mm 25mm')
    expect((html.match(/class="label"/g) || []).length).toBe(500)
  })
})
