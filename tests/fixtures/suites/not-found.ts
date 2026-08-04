import { notFoundCases, unknownRoutes, type NotFoundCase } from '../datasets/not-found.js'
import { unknownUuid } from '../ids.js'
import { expectStatus, type Suite } from './types.js'

export const notFoundSuite: Suite<NotFoundCase> = {
  name: 'Unknown resource',
  cases: notFoundCases,
  describe: (testCase) => `404 when asked to ${testCase.name}`,
  run: async ({ send }, testCase) => {
    const url = testCase.path.replace('{id}', unknownUuid()) + (testCase.query ?? '')
    const response = await send({ method: testCase.method, url, payload: testCase.body })

    const status = expectStatus(response, 404)
    if (status) return status
    const code = response.json()?.error
    return code === 'not_found' ? null : `expected error "not_found", got "${code}"`
  },
}

export const unknownRouteSuite: Suite<string> = {
  name: 'Unknown route',
  cases: unknownRoutes,
  describe: (path) => `404 in the uniform shape for ${path}`,
  run: async ({ send }, path) => {
    const response = await send({ method: 'GET', url: path })
    const status = expectStatus(response, 404)
    if (status) return status
    const body = response.json()
    return body?.error === 'not_found' && typeof body?.message === 'string'
      ? null
      : `expected the uniform 404 body, got ${response.body.slice(0, 120)}`
  },
}
