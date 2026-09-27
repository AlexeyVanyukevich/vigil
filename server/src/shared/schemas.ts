import { Type } from 'typebox'

/**
 * `minLength: 1` accepts `"   "`, which then reaches the database and trips a check constraint
 * — a 500 for what is plainly a bad request. Requiring one non-space character keeps the
 * refusal at the boundary, where it can name the field.
 *
 * The return type is inferred rather than widened to `TSchema`: the type provider reads the
 * concrete schema to type `request.body`, and a widened one leaves every field `unknown`.
 */
export function NonBlankString(options: { maxLength: number }) {
  return Type.String({ minLength: 1, pattern: '\\S', maxLength: options.maxLength })
}
