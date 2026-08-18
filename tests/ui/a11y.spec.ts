import { expect, test, type Page } from '@playwright/test'
import { consoleUrl, createTenant, resetConsoleDb } from './helpers.js'

test.beforeEach(resetConsoleDb)

async function openKeysPage(page: Page): Promise<void> {
  await createTenant(page)
}

test('every form still submits with JavaScript disabled', async ({ page, javaScriptEnabled }) => {
  test.skip(javaScriptEnabled, 'the point of the chromium-nojs project')
  await openKeysPage(page)

  await page.getByLabel('Name').fill('site')
  await page.getByRole('radio', { name: 'Widget', exact: true }).check()
  await page.getByRole('button', { name: 'Issue key' }).click()

  // The whole journey — create a tenant, issue a key, read the secret — with no script at all.
  await expect(page.locator('#secret')).toHaveValue(/^bk_live_/)
})

test.describe('each page', () => {
  for (const [name, open] of [
    ['tenants', async (page: Page) => page.goto(consoleUrl('/tenants'))],
    ['keys', openKeysPage],
  ] as const) {
    test(`${name}: every input has a label`, async ({ page }) => {
      await open(page)
      const unlabelled = await page.evaluate(
        () =>
          [...document.querySelectorAll('input')].filter(
            (input) =>
              (input.labels === null || input.labels.length === 0) &&
              input.getAttribute('aria-label') === null,
          ).length,
      )
      expect(unlabelled).toBe(0)
    })

    test(`${name}: has exactly one h1 and a titled document`, async ({ page }) => {
      await open(page)
      await expect(page.locator('h1')).toHaveCount(1)
      await expect(page).toHaveTitle(/Booking Engine console$/)
    })

    test(`${name}: does not scroll horizontally at 390px`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 800 })
      await open(page)
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)
    })
  }
})

test('a form submits by pressing Enter in a text field', async ({ page }) => {
  await page.goto(consoleUrl('/tenants'))
  await page.getByLabel('Name').fill('Houses')
  await page.getByLabel('Name').press('Enter')

  await expect(page.getByRole('link', { name: 'Houses' })).toBeVisible()
})

/**
 * Not "one Tab stop per control": a radio group is a single stop by design, and the arrow
 * keys move inside it. The property worth holding is that nothing is unreachable — every
 * checkbox, the name field, the selected preset and the submit button all take focus.
 */
test('every control on the keys page is reachable by keyboard', async ({
  page,
  javaScriptEnabled,
}) => {
  test.skip(!javaScriptEnabled, 'reads document.activeElement')
  await openKeysPage(page)

  const identify = () =>
    page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null
      if (active === null) return ''
      const named = active.getAttribute('name')
      const value = active.getAttribute('value')
      return (
        active.id || (named === null ? active.tagName.toLowerCase() : `${named}:${value ?? ''}`)
      )
    })

  const reached = new Set<string>()
  const stops = await page.locator('a, input, button').count()
  for (let i = 0; i < stops + 2; i += 1) {
    await page.keyboard.press('Tab')
    reached.add(await identify())
  }

  const scopes = await page
    .locator('input[name="scopes"]')
    .evaluateAll((nodes) => nodes.map((node) => `scopes:${node.getAttribute('value')}`))

  for (const expected of ['keyname', 'a', 'button', ...scopes]) {
    expect(reached, `Tab never reached ${expected}`).toContain(expected)
  }
  // The checked preset is the group's single stop.
  expect([...reached].some((id) => id.startsWith('preset:'))).toBe(true)
})
