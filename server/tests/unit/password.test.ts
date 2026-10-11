import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../../src/modules/auth/password.js'

describe('the owner password', () => {
  it('accepts the password it hashed', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true)
  })

  it('rejects a different one', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('incorrect horse', stored)).toBe(false)
  })

  it('refuses to hash a password too short to be worth stretching', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least 12/)
  })

  // A malformed stored hash is a failed login, not a 500 the owner cannot act on.
  it('treats an unreadable stored hash as a failed login', async () => {
    expect(await verifyPassword('anything', 'not a hash')).toBe(false)
  })

  it('salts, so the same password hashes differently twice', async () => {
    const password = 'correct horse battery staple'
    expect(await hashPassword(password)).not.toBe(await hashPassword(password))
  })
})
