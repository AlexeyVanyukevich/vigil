import { expect, test } from '@playwright/test'
import { runtime } from './helpers.js'

test('the owner is turned away without a password', async ({ page }) => {
  await page.goto(`${runtime.baseURL}/`)
  await expect(page).toHaveURL(/\/login$/)

  await page.getByLabel('Password').fill('not the password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toHaveText('Wrong password')
})
