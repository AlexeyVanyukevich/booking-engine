import { sql, type Kysely } from 'kysely'
import type { Page } from '@playwright/test'
import { createDb } from '../../src/db/client.js'
import type { Database } from '../../src/db/schema.js'

let db: Kysely<Database> | undefined

export function consoleUrl(path = '/'): string {
  return `${process.env.CONSOLE_URL}${path}`
}

function testDb(): Kysely<Database> {
  db ??= createDb(process.env.DATABASE_URL!)
  return db
}

export async function resetConsoleDb(): Promise<void> {
  await sql`truncate table bookings, schedule_exceptions, schedule, resources, api_keys, tenants restart identity cascade`.execute(
    testDb(),
  )
}

/** Calls the engine on its own port with a key that was issued through the UI. */
export async function dataPlane(
  path: string,
  key: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${process.env.DATA_PLANE_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      ...(init.headers ?? {}),
    },
  })
}

export async function createTenant(page: Page, name = 'Houses'): Promise<void> {
  await page.goto(consoleUrl('/tenants'))
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Create tenant' }).click()
  await page.getByRole('link', { name }).click()
}

/** Issues a key from the open keys page and returns the secret the reveal shows once. */
export async function issueKey(page: Page, name: string, preset: string): Promise<string> {
  await page.getByLabel('Name').fill(name)
  await page.getByRole('radio', { name: preset, exact: true }).check()
  await page.getByRole('button', { name: 'Issue key' }).click()
  return page.locator('#secret').inputValue()
}

/** The keys page without the one-shot reveal in the query string. */
export function withoutReveal(url: string): string {
  return url.split('?')[0]!
}

export const RESOURCE = {
  timezone: 'Europe/Warsaw',
  slot_duration: 'P1D',
  slot_anchor_time: '15:00',
  capacity: 1,
  concurrency_mode: 'exclusive',
}

export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
  day_of_week,
  start_time: null,
  end_time: null,
}))
