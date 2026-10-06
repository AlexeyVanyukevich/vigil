import { expect, test, type Page } from '@playwright/test'
import { endSessions, reportFrom, runtime, signIn, startProxy, type Failure } from './helpers.js'

// What jsdom could not prove for the dashboard's session handling: a real browser's history, its
// back-forward cache, a session ended on the server while the screen is open, and a server that
// cannot be reached. Each journey keeps to an environment of its own; see `issues.spec.ts`.

const SEEN_BEFORE_SIGNING_OUT: Failure = {
  mode: 'handled',
  message: 'read just before signing out',
  environment: 'qa',
}

const OPEN_WHEN_THE_SESSION_ENDED: Failure = {
  mode: 'handled',
  message: 'open when the session ended',
  environment: 'sandbox',
}

const titleOf = (failure: Failure) => `TypeError: ${failure.message}`

async function openIssue(page: Page, failure: Failure): Promise<void> {
  await page
    .getByRole('listitem')
    .filter({ hasText: titleOf(failure) })
    .getByRole('link')
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(titleOf(failure))
}

test('signing out ends the session', async ({ page }) => {
  await signIn(page)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login$/)

  await page.goto(`${runtime.baseURL}/`)
  await expect(page).toHaveURL(/\/login$/)
})

/**
 * Back, as the owner presses it. `page.goBack()` waits for a load event that a page restored from
 * the back-forward cache never fires, so the history is driven from inside the page.
 */
async function pressBack(page: Page, to: RegExp): Promise<void> {
  await page.evaluate(() => {
    setTimeout(() => history.back(), 0)
  })
  await page.waitForFunction((source) => new RegExp(source).test(location.href), to.source)
}

const LOGIN = /\/login$/
const ISSUE = /\/issues\/[^/]+$/
const LIST = /:\d+\/$/

/** Where the owner signs out, and what the history then holds behind the login screen. */
const SIGN_OUTS: Array<{
  name: string
  /** Signs in and out, leaving the login screen current; returns the screens Back reaches. */
  visit: (page: Page, baseURL: string) => Promise<RegExp[]>
  /** Whether those screens come back from the back-forward cache or from the page's memory. */
  restored: boolean
}> = [
  {
    // Nothing but the cache cleared on signing out stands between Back and the issue.
    name: 'and pressed Back straight away',
    visit: async (page, baseURL) => {
      await signIn(page, baseURL)
      await openIssue(page, SEEN_BEFORE_SIGNING_OUT)
      await page.getByRole('link', { name: '← Issues' }).click()
      await page.getByRole('button', { name: 'Sign out' }).click()
      await expect(page).toHaveURL(LOGIN)
      return [ISSUE, LIST]
    },
    restored: false,
  },
  {
    name: 'in the same visit, then away to another page and back',
    visit: async (page, baseURL) => {
      await signIn(page, baseURL)
      await openIssue(page, SEEN_BEFORE_SIGNING_OUT)
      await page.getByRole('link', { name: '← Issues' }).click()
      await page.getByRole('button', { name: 'Sign out' }).click()
      await expect(page).toHaveURL(LOGIN)

      // Out to another document and back: the dashboard returns from the back-forward cache, its
      // memory as it was when the owner signed out.
      await page.goto(`${baseURL}/api/health`)
      await pressBack(page, LOGIN)
      await expect(page.locator('html')).toHaveAttribute('data-restored', 'true')
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
      return [ISSUE, LIST]
    },
    restored: true,
  },
  {
    // The visit Back returns to never saw the sign-out: it went into the cache signed in.
    name: 'in a later visit to the dashboard, in the same tab',
    visit: async (page, baseURL) => {
      await signIn(page, baseURL)
      await openIssue(page, SEEN_BEFORE_SIGNING_OUT)
      await page.goto(`${baseURL}/`)
      await page.getByRole('button', { name: 'Sign out' }).click()
      await expect(page).toHaveURL(LOGIN)
      return [ISSUE, LIST]
    },
    restored: true,
  },
]

test.describe('after signing out, Back shows nothing the session could see', () => {
  test.beforeAll(async () => {
    await reportFrom(SEEN_BEFORE_SIGNING_OUT)
  })

  for (const signOut of SIGN_OUTS) {
    test(`signed out ${signOut.name}`, async ({ playwright }) => {
      // Playwright launches Chromium with the back-forward cache off, and its headless shell
      // cannot have one. This is the full browser with the cache on, as the owner's is.
      const browser = await playwright.chromium.launch({
        channel: 'chromium',
        ignoreDefaultArgs: ['--disable-back-forward-cache'],
      })
      const proxy = await startProxy(runtime.baseURL)
      try {
        const page = await browser.newPage()
        // Whether a document came back from the back-forward cache, with its memory intact.
        await page.addInitScript(() => {
          addEventListener('pageshow', (event) => {
            document.documentElement.dataset.restored = String(event.persisted)
          })
        })

        // Through a proxy that can hold the server's answers; see `Proxy.hold`.
        const screens = await signOut.visit(page, proxy.url)

        const protectedContent = [
          page.getByText(titleOf(SEEN_BEFORE_SIGNING_OUT)),
          page.getByRole('heading', { name: 'Issues' }),
          page.getByRole('button', { name: 'Sign out' }),
        ]

        for (const screen of screens) {
          const api = proxy.hold()
          await pressBack(page, screen)
          // The visit as the owner left it, memory and all — never a fresh load, which would
          // ask the server whatever the dashboard remembered.
          await expect(page.locator('html')).toHaveAttribute(
            'data-restored',
            String(signOut.restored),
          )

          // With every answer held, only a screen rendered from memory could show anything.
          // The dashboard asks the server whether the session is alive, and waits.
          await expect.poll(api.asked).toContain('/api/me')
          for (const content of protectedContent) await expect(content).toHaveCount(0)

          api.release()
          await expect(page).toHaveURL(LOGIN)
          for (const content of protectedContent) await expect(content).toHaveCount(0)
        }
      } finally {
        await browser.close()
        await proxy.close()
      }
    })
  }
})

/** What the owner does next, on a screen whose session the server has already ended. */
const NEXT_ACTIONS: Array<{
  name: string
  on: 'list' | 'issue'
  act: (page: Page) => Promise<unknown>
}> = [
  {
    name: 'changes a filter',
    on: 'list',
    act: (page) => page.getByLabel('Status').selectOption('resolved'),
  },
  {
    name: 'opens an issue',
    on: 'list',
    act: (page) =>
      page
        .getByRole('listitem')
        .filter({ hasText: titleOf(OPEN_WHEN_THE_SESSION_ENDED) })
        .getByRole('link')
        .click(),
  },
  {
    name: 'resolves the issue',
    on: 'issue',
    act: (page) => page.getByRole('button', { name: 'Resolve' }).click(),
  },
]

test.describe('the session ends on the server mid-use', () => {
  test.beforeAll(async () => {
    await reportFrom(OPEN_WHEN_THE_SESSION_ENDED)
  })

  for (const next of NEXT_ACTIONS) {
    test(`the owner ${next.name}, and lands on the login screen`, async ({ page }) => {
      await signIn(page)
      if (next.on === 'issue') await openIssue(page, OPEN_WHEN_THE_SESSION_ENDED)
      else {
        await expect(
          page.getByRole('listitem').filter({ hasText: titleOf(OPEN_WHEN_THE_SESSION_ENDED) }),
        ).toHaveCount(1)
      }

      await endSessions()
      await next.act(page)

      await expect(page).toHaveURL(/\/login$/)
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
    })
  }
})

/** Ways the server stops answering while the dashboard is open. */
const UNREACHABLE: Array<{
  name: string
  /** Signs in, and returns how to cut the server off and how to clean up. */
  open: (page: Page) => Promise<{ cutOff: () => Promise<void>; close: () => Promise<void> }>
}> = [
  {
    name: 'the proxy in front of it answers 502',
    open: async (page) => {
      const proxy = await startProxy(runtime.baseURL)
      await signIn(page, proxy.url)
      return { cutOff: async () => proxy.cutOff(), close: () => proxy.close() }
    },
  },
  {
    name: 'the connection itself is refused',
    open: async (page) => {
      await signIn(page)
      return {
        cutOff: async () => {
          await page.route('**/api/**', (route) => route.abort('connectionrefused'))
        },
        close: async () => {},
      }
    },
  },
]

for (const way of UNREACHABLE) {
  test(`when ${way.name}, the dashboard says it cannot reach the server`, async ({ page }) => {
    const server = await way.open(page)
    try {
      await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible()
      await server.cutOff()

      await page.getByLabel('Status').selectOption('resolved')

      await expect(page.getByRole('alert')).toHaveText(
        'Cannot reach the server. Check your connection.',
      )
    } finally {
      await server.close()
    }
  })
}
