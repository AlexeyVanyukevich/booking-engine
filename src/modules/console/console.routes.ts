import type { FastifyPluginAsync } from 'fastify'
import { ForbiddenOriginError, ValidationError } from '../../shared/errors.js'
import { expandPreset, isPresetName } from '../../shared/scopes.js'
import { TenantRepository } from '../tenants/tenant.repository.js'
import { TenantService } from '../tenants/tenant.service.js'
import { keysPage, tenantsPage } from './console.pages.js'
import { SecretFlash } from './flash.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function requireUuid(value: string, what: string): string {
  if (!UUID.test(value)) throw new ValidationError(`${what} is not a uuid`)
  return value
}

const HTML = 'text/html; charset=utf-8'

export const consoleRoutes: FastifyPluginAsync = async (app) => {
  const service = new TenantService(new TenantRepository(app.db))

  /**
   * Loopback keeps the network out; it does not keep out a page the operator already has open
   * in the same browser, which can post here from anywhere. A request carrying no `Origin` at
   * all is a non-browser client such as curl and is allowed — browsers always send it on a
   * form post, so its absence is not something an attacking page can arrange.
   *
   * The origin is compared against the `Host` the request was actually addressed to, not
   * against the configured port: the two agree in production, and deriving the expectation
   * from the request is what keeps the check working when the console is bound to an
   * ephemeral port. `Host` is set by the browser from the address it connected to, so a page
   * on evil.example posting here still sends its own `Origin` and is refused.
   *
   * Ten lines, and no CSRF token in every form.
   */
  app.addHook('onRequest', async (request) => {
    if (request.method === 'GET' || request.method === 'HEAD') return
    const origin = request.headers.origin
    if (origin === undefined) return

    const host = request.headers.host
    if (host === undefined || origin !== `http://${host}`) {
      throw new ForbiddenOriginError('This request did not come from the console')
    }
  })

  app.get('/', async (_request, reply) => reply.redirect('/tenants', 303))

  app.get('/tenants', async (_request, reply) => {
    const tenants = await service.listTenants()
    return reply.type(HTML).send(tenantsPage(tenants))
  })

  app.post<{ Body: { name?: string } }>('/tenants', async (request, reply) => {
    await service.createTenant(request.body?.name ?? '')
    // See-other, so a reload re-reads the list instead of re-posting the form.
    return reply.redirect('/tenants', 303)
  })

  const flash = new SecretFlash()

  app.get<{ Params: { id: string }; Querystring: { revealed?: string } }>(
    '/tenants/:id/api-keys',
    async (request, reply) => {
      const id = requireUuid(request.params.id, 'Tenant id')
      const tenant = await service.getTenant(id)
      const keys = await service.listKeys(id)
      // Reading the flash consumes it, which is what makes a reload show the plain list.
      const secret =
        request.query.revealed === undefined ? undefined : flash.take(request.query.revealed)
      return reply.type(HTML).send(keysPage(tenant, keys, secret))
    },
  )

  app.post<{
    Params: { id: string }
    Body: { name?: string; preset?: string; scopes?: string | string[] }
  }>('/tenants/:id/api-keys', async (request, reply) => {
    const id = requireUuid(request.params.id, 'Tenant id')
    const { name = '', preset = '', scopes } = request.body ?? {}

    // The preset is expanded here and the name is thrown away. Storing the name would mean
    // that editing a preset tomorrow silently changes the authority of keys already issued.
    let requested: string[]
    if (preset === 'custom') {
      // A single checkbox arrives as a string, several as an array.
      requested = scopes === undefined ? [] : Array.isArray(scopes) ? scopes : [scopes]
    } else if (isPresetName(preset)) {
      requested = expandPreset(preset)
    } else {
      throw new ValidationError(`Unknown preset "${preset}"`)
    }

    const { secret } = await service.issueKey(id, name, requested)
    return reply.redirect(`/tenants/${id}/api-keys?revealed=${flash.put(secret)}`, 303)
  })

  /**
   * A POST, not a DELETE: these are HTML forms, and a form cannot issue DELETE without
   * JavaScript, which this console deliberately does not depend on.
   */
  app.post<{ Params: { id: string } }>('/api-keys/:id/revoke', async (request, reply) => {
    const keyId = requireUuid(request.params.id, 'Key id')
    const revoked = await service.revokeKey(keyId)
    return reply.redirect(`/tenants/${revoked.tenant_id}/api-keys`, 303)
  })
}
