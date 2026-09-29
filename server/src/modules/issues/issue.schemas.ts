import { Type, type Static } from 'typebox'

const Status = Type.Union([Type.Literal('open'), Type.Literal('resolved'), Type.Literal('ignored')])

export const IssueListQuery = Type.Object(
  {
    app: Type.Optional(Type.String({ maxLength: 64 })),
    environment: Type.Optional(Type.String({ maxLength: 64 })),
    status: Type.Optional(Status),
    sort: Type.Optional(Type.Union([Type.Literal('last_seen'), Type.Literal('count')])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
)

/**
 * A pattern, not `format: 'uuid'`: ajv-formats also accepts the `urn:uuid:` form, which
 * Postgres's uuid input refuses, and a refusal from Postgres is a 500 where a 400 belongs.
 */
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

export const IssueParams = Type.Object(
  { id: Type.String({ pattern: UUID }) },
  { additionalProperties: false },
)

export const IssueStatusBody = Type.Object({ status: Status }, { additionalProperties: false })

export type IssueListQueryType = Static<typeof IssueListQuery>
