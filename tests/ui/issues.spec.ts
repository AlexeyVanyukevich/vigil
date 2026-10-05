import { expect, test, type Page } from '@playwright/test'
import { reportFrom, runtime, signIn, type Failure } from './helpers.js'

// Every failure below is reported by the owner's own application through the real
// `@vigil/client` with the issued key (see `host.ts`). They all throw from the same line, so the
// fingerprint alone would make them one issue; each journey keeps to an environment of its own,
// which is part of an issue's identity, so no journey reads another's counts.

/** §1's driving case: one crash overnight, then the same failure in a hot loop, caught. */
const NIGHT = {
  crash: { mode: 'crash', message: 'the night shift broke', environment: 'production' },
  loop: { mode: 'handled', message: 'the night shift broke', environment: 'production', times: 99 },
  /** One crash plus ninety-nine caught, the ninety-nine collapsed into one event. */
  count: 100,
  events: 2,
  collapsed: '×99',
} satisfies { crash: Failure; loop: Failure; count: number; events: number; collapsed: string }

const REGRESSION: Failure = {
  mode: 'handled',
  message: 'fixed, then broken again',
  environment: 'staging',
}

/** One failure in two environments is two issues, and the environment filter tells them apart. */
const FILTERED = {
  kept: { mode: 'handled', message: 'on a laptop', environment: 'development' },
  dropped: { mode: 'handled', message: 'on the preview box', environment: 'preview' },
} satisfies Record<string, Failure>

/** The list's count column: the number, then "time" or "times". */
const timesSeen = (count: number) => new RegExp(`^${count}\\s*times?$`)

const rowFor = (page: Page, message: string) =>
  page.getByRole('listitem').filter({ hasText: `TypeError: ${message}` })

test('the owner is turned away without a password', async ({ page }) => {
  await page.goto(`${runtime.baseURL}/`)
  await expect(page).toHaveURL(/\/login$/)

  await page.getByLabel('Password').fill('not the password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toHaveText('Wrong password')
})

// §1, end to end: something threw overnight, and the owner learns what it was, how often, where,
// and whether it is still happening, without having read a log file.
test('an application throws, and the owner reads it in the morning', async ({ page }) => {
  await reportFrom(NIGHT.crash)
  await reportFrom(NIGHT.loop)

  await signIn(page)

  const row = rowFor(page, NIGHT.crash.message)
  // A hundred failures are one line.
  await expect(row).toHaveCount(1)
  await expect(row.locator('.issue__count')).toHaveText(timesSeen(NIGHT.count))
  await expect(row).toContainText('The reference application')
  await expect(row).toContainText(NIGHT.crash.environment)
  await expect(row).toContainText('last seen just now')
  await expect(row.locator('.issue__culprit')).toHaveText(
    /^handleBooking \(.*\/src\/bookings\.mjs\)$/,
  )

  await row.getByRole('link').click()

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    `TypeError: ${NIGHT.crash.message}`,
  )
  await expect(page.getByText(`${NIGHT.count} occurrences`)).toBeVisible()
  await expect(page.getByText(/last seen just now/)).toBeVisible()
  // Ninety-nine caught in a loop arrived as one event standing for all of them.
  const occurrences = page.locator('.occurrence')
  await expect(occurrences).toHaveCount(NIGHT.events)
  await expect(occurrences.filter({ hasText: NIGHT.collapsed })).toHaveCount(1)

  // The owner's own frame is on top and in plain sight; the framework's are folded behind one
  // line, there to be opened, not read past.
  const stack = page.locator('.stack')
  await expect(stack.getByText(/at handleBooking \(.*\/src\/bookings\.mjs:\d+:\d+\)/)).toBeVisible()
  const fold = stack.locator('details.stack__fold')
  await expect(fold.locator('summary')).toHaveText('2 frames in node_modules')
  await expect(fold.locator('.stack__frame--vendor').first()).toBeHidden()
  await fold.locator('summary').click()
  await expect(fold.locator('.stack__frame--vendor')).toHaveText([
    /at invoke \(.*\/node_modules\/tiny-router\/index\.js:\d+:\d+\)/,
    /at dispatch \(.*\/node_modules\/tiny-router\/index\.js:\d+:\d+\)/,
  ])

  await expect(page.locator('.context')).toContainText('/api/bookings')
})

test('resolving an issue takes it out of the open list, and a regression brings it back', async ({
  page,
}) => {
  await reportFrom(REGRESSION)

  await signIn(page)
  await rowFor(page, REGRESSION.message).getByRole('link').click()
  await page.getByRole('button', { name: 'Resolve' }).click()
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible()

  await page.getByRole('link', { name: '← Issues' }).click()
  await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible()
  await expect(rowFor(page, REGRESSION.message)).toHaveCount(0)

  await page.getByLabel('Status').selectOption('resolved')
  await expect(rowFor(page, REGRESSION.message)).toHaveCount(1)

  // It happens again. A resolved issue that regresses reopens — the transition Slice 2 turns
  // into a notification. Reloaded, as the owner opening the dashboard later would: the list
  // keeps an answer for ten seconds, and this is not a test of that.
  await reportFrom(REGRESSION)
  await page.reload()
  await expect(page.getByLabel('Status')).toHaveValue('open')
  const row = rowFor(page, REGRESSION.message)
  await expect(row).toHaveCount(1)
  await expect(row.locator('.issue__count')).toHaveText(timesSeen(2))
  await expect(row).toContainText('last seen just now')

  await row.getByRole('link').click()
  await expect(page.getByRole('button', { name: 'Resolve' })).toBeVisible()
})

test('the filters narrow the list', async ({ page }) => {
  await reportFrom(FILTERED.kept)
  await reportFrom(FILTERED.dropped)

  await signIn(page)
  await expect(rowFor(page, FILTERED.kept.message)).toHaveCount(1)
  await expect(rowFor(page, FILTERED.dropped.message)).toHaveCount(1)

  // A developer's laptop must never share a row — or, from Slice 2, an alert — with anywhere
  // else.
  await page.getByLabel('Environment').selectOption(FILTERED.kept.environment)
  await expect(rowFor(page, FILTERED.kept.message)).toHaveCount(1)
  await expect(rowFor(page, FILTERED.dropped.message)).toHaveCount(0)

  await page.getByLabel('Environment').selectOption({ label: 'All environments' })
  await page.getByLabel('Application').selectOption({ label: 'Vigil itself' })
  await expect(page.getByText('Nothing here. That is the good outcome.')).toBeVisible()

  await page.getByLabel('Application').selectOption({ label: 'The reference application' })
  await expect(rowFor(page, FILTERED.kept.message)).toHaveCount(1)
  await expect(rowFor(page, FILTERED.dropped.message)).toHaveCount(1)
})
