import { expect, test } from '@playwright/test'
import { consoleUrl, resetConsoleDb } from './helpers.js'

test.beforeEach(resetConsoleDb)

const form = { name: 'Houses' }

test('refuses a write from a foreign origin and creates nothing', async ({ page, request }) => {
  const response = await request.post(consoleUrl('/tenants'), {
    form,
    headers: { origin: 'https://evil.example' },
    maxRedirects: 0,
  })
  expect(response.status()).toBe(403)

  await page.goto(consoleUrl('/tenants'))
  await expect(page.getByText('No tenants yet')).toBeVisible()
})

// Browsers always send Origin on a form post, so its absence means a non-browser client.
test('accepts a write with no origin, which is curl', async ({ request }) => {
  const response = await request.post(consoleUrl('/tenants'), { form, maxRedirects: 0 })
  expect(response.status()).toBe(303)
})

test('accepts a write from the console own origin', async ({ request }) => {
  const response = await request.post(consoleUrl('/tenants'), {
    form,
    headers: { origin: process.env.CONSOLE_URL! },
    maxRedirects: 0,
  })
  expect(response.status()).toBe(303)
})

test('leaves reads alone whatever the origin', async ({ request }) => {
  const response = await request.get(consoleUrl('/tenants'), {
    headers: { origin: 'https://evil.example' },
  })
  expect(response.status()).toBe(200)
})

test('answers an HTML 404 for an unknown path', async ({ page }) => {
  const response = await page.goto(consoleUrl('/nope'))
  expect(response?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: '404' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to tenants' })).toBeVisible()
})

test('never serves the console over a route the data plane owns', async ({ request }) => {
  // The two planes share a database and nothing else; /resources belongs to the engine.
  const response = await request.get(consoleUrl('/resources'))
  expect(response.status()).toBe(404)
})
