import { Type, type Static } from 'typebox'
import { NonBlankString } from '../../shared/schemas.js'

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
      environment: NonBlankString({ maxLength: 64 }),
      runtime: Type.Union([Type.Literal('node'), Type.Literal('browser')]),
      events: Type.Array(
        Type.Object(
          {
            /** The error's constructor name. */
            type: NonBlankString({ maxLength: 200 }),
            message: Type.String({ maxLength: 4_000 }),
            stack: Type.Optional(Type.String()),
            occurred_at: Type.String({ format: 'date-time' }),
            context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
            /** §8's local collapse: one event standing for many identical throws. */
            count: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
            /** §7's escape hatch. */
            fingerprint: Type.Optional(Type.String({ maxLength: 200 })),
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
