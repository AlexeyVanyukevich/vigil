import { Type } from 'typebox'
import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { AuthService } from './auth.service.js'
import { registerGuard, UnauthorizedError } from './guard.js'

const LoginBody = Type.Object(
  { password: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
)

export async function registerAuth(instance: FastifyInstance): Promise<void> {
  // Re-applied here because the provider does not survive being passed as a plain
  // FastifyInstance, and without it a validated body arrives typed as `unknown`.
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new AuthService(app.db, app.config.sessionTtlDays)

  await app.register(import('@fastify/cookie'))
  await app.register(import('@fastify/rate-limit'), { global: false })

  registerGuard(app, service)

  app.post(
    '/api/login',
    {
      schema: { body: LoginBody },
      config: {
        public: true,
        rateLimit: { max: app.config.loginAttemptsPerMinute, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const token = await service.signIn(request.body.password)
      // One answer whether the password was wrong or none has ever been set: which of the two
      // it is must not be readable from outside.
      if (token === undefined) throw new UnauthorizedError('Wrong password')

      void reply
        .setCookie('session', token, {
          httpOnly: true,
          sameSite: 'lax',
          // Off in tests and on http://localhost; a Secure cookie is simply not stored there.
          secure: process.env.NODE_ENV === 'production',
          path: '/',
          maxAge: app.config.sessionTtlDays * 24 * 60 * 60,
        })
        .status(204)
        .send()
    },
  )

  app.post('/api/logout', async (request, reply) => {
    await service.signOut(request.sessionId)
    void reply.clearCookie('session', { path: '/' }).status(204).send()
  })

  app.get('/api/me', async () => ({ signedIn: true }))
}
