import { Type, type Static } from 'typebox'
import { NonBlankString } from '../../shared/schemas.js'

// Exported so `ingest.body-limit.ts` can size the route's raw-body limit from the same numbers
// the schema validates against, instead of a second, driftable copy of each one.
export const MAX_ENVIRONMENT_LENGTH = 64
export const MAX_TYPE_LENGTH = 200
export const MAX_MESSAGE_LENGTH = 4_000
export const MAX_FINGERPRINT_LENGTH = 200

/**
 * One wire format for both key kinds (§4). Slice 4 adds the browser policy around this schema;
 * it does not add a second shape.
 *
 * `maxItems` is applied at registration from `config.maxEventsPerBatch`, so the batch cap is
 * refused by the schema — a 400 naming the field — rather than counted in the service.
 */
export function IngestBody(maxEventsPerBatch: number) {
  return Type.Object(
    {
      environment: NonBlankString({ maxLength: MAX_ENVIRONMENT_LENGTH }),
      runtime: Type.Union([Type.Literal('node'), Type.Literal('browser')]),
      events: Type.Array(
        Type.Object(
          {
            /** The error's constructor name. */
            type: NonBlankString({ maxLength: MAX_TYPE_LENGTH }),
            message: Type.String({ maxLength: MAX_MESSAGE_LENGTH }),
            stack: Type.Optional(Type.String()),
            occurred_at: Type.String({ format: 'date-time' }),
            context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
            /** §8's local collapse: one event standing for many identical throws. */
            count: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
            /** §7's escape hatch. */
            fingerprint: Type.Optional(Type.String({ maxLength: MAX_FINGERPRINT_LENGTH })),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: maxEventsPerBatch },
      ),
    },
    { additionalProperties: false },
  )
}

export type IngestBodyType = Static<ReturnType<typeof IngestBody>>
