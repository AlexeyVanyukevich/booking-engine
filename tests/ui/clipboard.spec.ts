import { expect, test } from '@playwright/test'
import { createTenant, issueKey, resetConsoleDb } from './helpers.js'

test.beforeEach(resetConsoleDb)

test('copies the full secret to the clipboard', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are granted per browser')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])

  await createTenant(page)
  const secret = await issueKey(page, 'site', 'Widget')

  await page.getByRole('button', { name: 'Copy' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret)
})

test('leaves the secret selectable when the copy button cannot work', async ({ page }) => {
  await createTenant(page)
  const secret = await issueKey(page, 'site', 'Widget')

  // Readonly rather than disabled: a disabled input cannot be selected or copied by hand.
  const input = page.locator('#secret')
  await expect(input).toHaveValue(secret)
  await expect(input).toHaveAttribute('readonly', '')
  await expect(input).toBeEditable({ editable: false })
})
