import { hash, verify } from '@node-rs/argon2'

const MIN_LENGTH = 12

/**
 * Argon2id, deliberately unlike the SHA-256 over ingest keys. There the secret carries 256 bits
 * from a CSPRNG and there is nothing to brute-force; here it is a phrase a person chose, and
 * making each guess expensive is the whole defence.
 */
export async function hashPassword(password: string): Promise<string> {
  if (password.trim().length < MIN_LENGTH) {
    throw new Error(`The password must be at least ${MIN_LENGTH} characters`)
  }
  return hash(password)
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    return await verify(stored, password)
  } catch {
    // A malformed stored hash is a failed login, not a 500.
    return false
  }
}
