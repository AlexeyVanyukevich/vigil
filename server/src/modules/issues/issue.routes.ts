import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { NotFoundError } from '../../shared/errors.js'
import { replaceNul } from '../../shared/nul.js'
import { findIssue, listIssues, recentOccurrences, setIssueStatus } from './issue.repository.js'
import { IssueListQuery, IssueParams, IssueStatusBody } from './issue.schemas.js'

/** Enough to see whether the shape of a failure changes, few enough to render at once. */
const OCCURRENCES_ON_DETAIL = 25
const DEFAULT_LIST_LIMIT = 100

export function registerIssues(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()

  app.get('/api/issues', { schema: { querystring: IssueListQuery } }, async (request) => {
    const query = request.query
    const issues = await listIssues(app.db, {
      // Postgres refuses U+0000 in text outright, so a filter carrying one would be a 500.
      // Replaced the way ingest replaced it on the way in, so the filter matches what is stored.
      appSlug: query.app === undefined ? undefined : replaceNul(query.app),
      environment: query.environment === undefined ? undefined : replaceNul(query.environment),
      status: query.status,
      sort: query.sort ?? 'last_seen',
      limit: query.limit ?? DEFAULT_LIST_LIMIT,
    })
    return { issues }
  })

  app.get('/api/issues/:id', { schema: { params: IssueParams } }, async (request) => {
    const issue = await findIssue(app.db, request.params.id)
    if (issue === undefined) throw new NotFoundError('No such issue')

    const events = await recentOccurrences(app.db, issue.id, OCCURRENCES_ON_DETAIL)
    return { issue, events }
  })

  app.patch(
    '/api/issues/:id',
    { schema: { params: IssueParams, body: IssueStatusBody } },
    async (request, reply) => {
      const changed = await setIssueStatus(app.db, request.params.id, request.body.status)
      if (!changed) throw new NotFoundError('No such issue')
      void reply.status(204).send()
    },
  )
}
