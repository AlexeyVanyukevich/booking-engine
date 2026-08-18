import { expect, test } from '@playwright/test'
import {
  EVERY_DAY,
  RESOURCE,
  consoleUrl,
  createTenant,
  dataPlane,
  issueKey,
  resetConsoleDb,
  withoutReveal,
} from './helpers.js'

test.beforeEach(resetConsoleDb)

test('explains an empty key list', async ({ page }) => {
  await createTenant(page)
  await expect(page.getByText('No keys yet')).toBeVisible()
})

test('reveals the secret once, with a prefix matching the listed key', async ({ page }) => {
  await createTenant(page)
  const secret = await issueKey(page, 'site', 'Site backend')

  expect(secret).toMatch(/^bk_live_[A-Za-z0-9]{51}$/)
  await expect(page.locator('tbody')).toContainText(secret.slice(8, 16))
})

test('loses the secret on reload and renders the list normally', async ({ page }) => {
  await createTenant(page)
  const secret = await issueKey(page, 'site', 'Site backend')

  await page.reload()
  await expect(page.locator('#secret')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(secret)
  await expect(page.locator('tbody')).toContainText('site')
})

test('does not resurrect the secret by returning to the reveal url', async ({ page }) => {
  await createTenant(page)
  const secret = await issueKey(page, 'site', 'Site backend')
  const revealUrl = page.url()

  await page.goto(consoleUrl('/tenants'))
  await page.goto(revealUrl)
  await expect(page.locator('body')).not.toContainText(secret)
})

test('reloading the reveal page does not issue a second key', async ({ page }) => {
  await createTenant(page)
  await issueKey(page, 'site', 'Site backend')

  await page.reload()
  await expect(page.locator('tbody tr')).toHaveCount(1)
})

test('keeps the secret out of the list markup entirely', async ({ page }) => {
  await createTenant(page)
  const secret = await issueKey(page, 'site', 'Widget')

  await page.goto(withoutReveal(page.url()))
  expect(await page.content()).not.toContain(secret)
})

test('stores the partner preset without bookings.list and the site preset with it', async ({
  page,
}) => {
  await createTenant(page)
  await issueKey(page, 'partner', 'Partner channel')
  await page.goto(withoutReveal(page.url()))

  const partner = page.locator('tbody tr', { hasText: 'partner' })
  await expect(partner).toContainText('bookings.write')
  await expect(partner).not.toContainText('bookings.list')

  await issueKey(page, 'site', 'Site backend')
  await page.goto(withoutReveal(page.url()))
  await expect(page.locator('tbody tr', { hasText: 'site' })).toContainText('bookings.list')
})

test('shows the scopes a key holds, not the preset that produced them', async ({ page }) => {
  await createTenant(page)
  await issueKey(page, 'partner', 'Partner channel')
  await page.goto(withoutReveal(page.url()))

  await expect(page.locator('tbody')).not.toContainText('partner_channel')
})

test('issues a custom subset', async ({ page }) => {
  await createTenant(page)
  await page.getByLabel('Name').fill('odd')
  await page.getByRole('radio', { name: 'Custom' }).check()
  await page.getByRole('checkbox', { name: 'schedule.write' }).check()
  await page.getByRole('button', { name: 'Issue key' }).click()

  await page.goto(withoutReveal(page.url()))
  const row = page.locator('tbody tr', { hasText: 'odd' })
  await expect(row).toContainText('schedule.write')
  await expect(row).not.toContainText('bookings.write')
})

test('refuses custom with nothing ticked', async ({ page }) => {
  await createTenant(page)
  await page.getByLabel('Name').fill('empty')
  await page.getByRole('radio', { name: 'Custom' }).check()
  await page.getByRole('button', { name: 'Issue key' }).click()

  await expect(page.locator('body')).toContainText('at least one scope')
})

test('lists two keys with different prefixes', async ({ page }) => {
  await createTenant(page)
  const first = await issueKey(page, 'one', 'Widget')
  await page.goto(withoutReveal(page.url()))
  const second = await issueKey(page, 'two', 'Widget')

  expect(first.slice(8, 16)).not.toBe(second.slice(8, 16))
  await page.goto(withoutReveal(page.url()))
  await expect(page.locator('tbody tr')).toHaveCount(2)
})

// The test the whole spec exists for.
test('a key issued here works against the engine and sees only its own tenant', async ({
  page,
}) => {
  await createTenant(page, 'Owner A')
  const keyA = await issueKey(page, 'back office', 'Back office')

  const created = await dataPlane('/resources', keyA, {
    method: 'POST',
    body: JSON.stringify(RESOURCE),
  })
  expect(created.status).toBe(201)
  const resourceId = ((await created.json()) as { id: string }).id

  expect((await dataPlane(`/resources/${resourceId}`, keyA)).status).toBe(200)

  await createTenant(page, 'Owner B')
  const keyB = await issueKey(page, 'back office', 'Back office')
  expect((await dataPlane(`/resources/${resourceId}`, keyB)).status).toBe(404)
  expect(await (await dataPlane('/resources', keyB)).json()).toEqual([])
})

// The preset's whole purpose, verified through the UI that issues it.
test('a Partner channel key can book and cannot read the calendar', async ({ page }) => {
  await createTenant(page, 'Owner')
  const admin = await issueKey(page, 'admin', 'Back office')

  const resourceId = (
    (await (
      await dataPlane('/resources', admin, { method: 'POST', body: JSON.stringify(RESOURCE) })
    ).json()) as { id: string }
  ).id

  await dataPlane(`/resources/${resourceId}/schedule`, admin, {
    method: 'PUT',
    body: JSON.stringify(EVERY_DAY),
  })

  await page.goto(withoutReveal(page.url()))
  const partner = await issueKey(page, 'partner', 'Partner channel')

  const booked = await dataPlane(`/resources/${resourceId}/bookings`, partner, {
    method: 'POST',
    body: JSON.stringify({
      customer_id: 'guest-1',
      start_time: '2026-09-01T15:00:00+02:00',
      end_time: '2026-09-02T15:00:00+02:00',
    }),
  })
  expect(booked.status).toBe(201)

  const calendar = await dataPlane('/bookings?from=2026-09-01&to=2026-09-08', partner)
  expect(calendar.status).toBe(403)
  expect(((await calendar.json()) as { details: unknown }).details).toEqual({
    required: 'bookings.list',
  })
})

test('a Widget key cannot create a resource', async ({ page }) => {
  await createTenant(page)
  const widget = await issueKey(page, 'widget', 'Widget')

  const response = await dataPlane('/resources', widget, {
    method: 'POST',
    body: JSON.stringify(RESOURCE),
  })
  expect(response.status).toBe(403)
})

test.describe('revocation', () => {
  test('marks the key revoked, keeps the row, and refuses it at the engine', async ({ page }) => {
    await createTenant(page)
    const secret = await issueKey(page, 'site', 'Widget')
    await page.goto(withoutReveal(page.url()))

    await page.getByRole('button', { name: 'Revoke' }).click()

    await expect(page.locator('tbody tr')).toHaveCount(1)
    await expect(page.locator('tbody')).toContainText('revoked')
    await expect(page.getByRole('button', { name: 'Revoke' })).toHaveCount(0)

    expect((await dataPlane('/resources', secret)).status).toBe(401)
  })

  test('answers 404 revoking an unknown key', async ({ page, request }) => {
    await createTenant(page)
    const response = await request.post(
      consoleUrl('/api-keys/00000000-0000-4000-8000-000000000000/revoke'),
    )
    expect(response.status()).toBe(404)
  })
})
