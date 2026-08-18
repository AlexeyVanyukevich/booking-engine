import { describe, expect, it } from 'vitest'
import { escapeHtml, page } from '../../src/modules/console/html.js'

describe('escapeHtml', () => {
  it.each([
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['&', '&amp;'],
    ['"', '&quot;'],
    ["'", '&#39;'],
  ])('escapes %s', (input, expected) => {
    expect(escapeHtml(input)).toBe(expected)
  })

  it('escapes a script tag whole', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes an attribute breakout', () => {
    expect(escapeHtml('" onerror="alert(1)')).toBe('&quot; onerror=&quot;alert(1)')
  })

  it('leaves ordinary text alone, including non-Latin', () => {
    expect(escapeHtml('Дом у озера 🏡')).toBe('Дом у озера 🏡')
  })

  // If `&` were escaped after the others, `<` would become `&amp;lt;` and render as text.
  it('escapes the ampersand before the entities it introduces', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })
})

describe('page', () => {
  it('escapes the title and sets exactly one h1', () => {
    const html = page('<b>Tenants</b>', '<p>body</p>')
    expect(html).toContain('&lt;b&gt;Tenants&lt;/b&gt;')
    expect(html).not.toContain('<b>Tenants</b>')
    expect(html.match(/<h1>/g)).toHaveLength(1)
  })

  it('names the console in the document title', () => {
    expect(page('Tenants', '')).toMatch(/<title>[^<]*Booking Engine console<\/title>/)
  })

  it('passes the body through unescaped, because it is already markup', () => {
    expect(page('Tenants', '<table><tr><td>x</td></tr></table>')).toContain('<table>')
  })

  it('declares a viewport so the page is usable on a narrow screen', () => {
    expect(page('Tenants', '')).toContain('name="viewport"')
  })
})
