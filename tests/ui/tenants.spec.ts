import { expect, test } from '@playwright/test'
import { consoleUrl, resetConsoleDb } from './helpers.js'

test.beforeEach(resetConsoleDb)

test('explains an empty tenant list instead of showing nothing', async ({ page }) => {
  await page.goto(consoleUrl('/tenants'))
  await expect(page.getByText('No tenants yet')).toBeVisible()
})

test('creates a tenant and shows it with its id', async ({ page }) => {
  await page.goto(consoleUrl('/tenants'))
  await page.getByLabel('Name').fill('Houses')
  await page.getByRole('button', { name: 'Create tenant' }).click()

  await expect(page.getByRole('link', { name: 'Houses' })).toBeVisible()
  await expect(page.locator('td.mono')).toContainText(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
  )
})

// The browser's own `required` and `maxlength` stop most of this, so the server side is
// probed by submitting past them.
test.describe('names the server refuses', () => {
  for (const [value, expected] of [
    ['   ', /must not be blank/],
    ['x'.repeat(101), /at most 100/],
  ] as const) {
    test(`refuses ${value.length > 20 ? 'a name past the limit' : 'a whitespace-only name'}`, async ({
      page,
      javaScriptEnabled,
    }) => {
      test.skip(!javaScriptEnabled, 'submits past the browser validation, which needs a script')
      await page.goto(consoleUrl('/tenants'))
      await page.evaluate((name) => {
        const input = document.querySelector<HTMLInputElement>('#name')!
        input.removeAttribute('maxlength')
        input.removeAttribute('required')
        input.value = name
        document.querySelector<HTMLFormElement>('form')!.submit()
      }, value)

      await expect(page.locator('body')).toContainText(expected)
      await page.goto(consoleUrl('/tenants'))
      await expect(page.getByText('No tenants yet')).toBeVisible()
    })
  }
})

test('renders a script tag as text and runs nothing', async ({ page }) => {
  let dialogs = 0
  page.on('dialog', async (dialog) => {
    dialogs += 1
    await dialog.dismiss()
  })

  await page.goto(consoleUrl('/tenants'))
  await page.getByLabel('Name').fill('<script>alert(1)</script>')
  await page.getByRole('button', { name: 'Create tenant' }).click()

  await expect(page.getByRole('link', { name: '<script>alert(1)</script>' })).toBeVisible()
  expect(dialogs).toBe(0)
})

test('round-trips emoji and Cyrillic', async ({ page }) => {
  await page.goto(consoleUrl('/tenants'))
  await page.getByLabel('Name').fill('Дом у озера 🏡')
  await page.getByRole('button', { name: 'Create tenant' }).click()
  await expect(page.getByRole('link', { name: 'Дом у озера 🏡' })).toBeVisible()
})

test('allows two tenants with the same name, distinguishable by id', async ({ page }) => {
  await page.goto(consoleUrl('/tenants'))
  for (let i = 0; i < 2; i += 1) {
    await page.getByLabel('Name').fill('Houses')
    await page.getByRole('button', { name: 'Create tenant' }).click()
  }

  const ids = await page.locator('td.mono').allTextContents()
  expect(ids).toHaveLength(2)
  expect(ids[0]).not.toBe(ids[1])
})

test('reloading after creating does not create a second tenant', async ({ page }) => {
  await page.goto(consoleUrl('/tenants'))
  await page.getByLabel('Name').fill('Houses')
  await page.getByRole('button', { name: 'Create tenant' }).click()

  await page.reload()
  await expect(page.getByRole('link', { name: 'Houses' })).toHaveCount(1)
})

test('follows the link into a tenant keys page', async ({ page }) => {
  await page.goto(consoleUrl('/tenants'))
  await page.getByLabel('Name').fill('Houses')
  await page.getByRole('button', { name: 'Create tenant' }).click()
  await page.getByRole('link', { name: 'Houses' }).click()

  await expect(page.getByRole('heading', { name: 'Keys · Houses' })).toBeVisible()
})

test('answers 404 for a well-formed unknown tenant', async ({ page }) => {
  const response = await page.goto(
    consoleUrl('/tenants/00000000-0000-4000-8000-000000000000/api-keys'),
  )
  expect(response?.status()).toBe(404)
  await expect(page.getByText('No tenant with id')).toBeVisible()
})

test('answers 400, not a stack trace, for a malformed uuid', async ({ page }) => {
  const response = await page.goto(consoleUrl('/tenants/not-a-uuid/api-keys'))
  expect(response?.status()).toBe(400)
  await expect(page.locator('body')).not.toContainText('at Object.')
  await expect(page.getByText('is not a uuid')).toBeVisible()
})

test('redirects the root to the tenant list', async ({ page }) => {
  await page.goto(consoleUrl('/'))
  await expect(page).toHaveURL(consoleUrl('/tenants'))
})
