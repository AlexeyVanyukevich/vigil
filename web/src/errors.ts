import { ApiError } from './api'

/**
 * Only a code is ever looked up here. A server message is never shown: those are written for
 * whoever maintains vigil and for the test suite, and the vocabulary they share with the
 * interface is the code, not the sentence.
 */
const COPY: Record<string, string> = {
  offline: 'Cannot reach the server. Check your connection.',
  unauthorized: 'Your session expired. Sign in again.',
  validation_error: 'The server refused that request.',
  not_found: 'That is not here any more.',
  conflict: 'Something changed while you were looking. Reload and try again.',
  payload_too_large: 'That report was too large to store.',
  bad_request: 'The server refused that request.',
  internal_error: 'Something went wrong on the server. Try again.',
}

const GENERIC = 'Something went wrong. Try again.'

/**
 * `fallback` says what failed, for a code with no copy of its own — "could not resolve the
 * issue" reads better than the generic line when the screen knows what was being attempted.
 */
export function messageFor(cause: unknown, fallback: string = GENERIC): string {
  if (cause instanceof ApiError) return COPY[cause.code] ?? fallback
  return fallback
}
