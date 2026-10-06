import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { recordContract, takeContractMismatches } from '../integration/contract.js'
import { recorderCases, type RecorderCase } from '../fixtures/datasets/contract-recorder.js'

function responseMap({ declares, declaredHeaders }: RecorderCase) {
  return Object.fromEntries(
    Object.entries(declares).map(([status, codes]) => [
      status,
      codes === null
        ? { type: 'object', additionalProperties: true }
        : {
            type: 'object',
            properties: { error: { type: 'string', enum: codes }, message: { type: 'string' } },
            ...(declaredHeaders?.[Number(status)]
              ? {
                  headers: Object.fromEntries(
                    declaredHeaders[Number(status)]!.map((h) => [h, { type: 'string' }]),
                  ),
                }
              : {}),
          },
    ]),
  )
}

// This file creates mismatches on purpose, so it takes them itself before the setup file looks.
afterEach(() => void takeContractMismatches())

describe('the contract recorder', () => {
  it.each(recorderCases)('$name', async (testCase) => {
    const app = Fastify()
    recordContract(app)
    app.route({
      method: testCase.method,
      url: testCase.url,
      schema: { response: responseMap(testCase) },
      handler: async (_request, reply) => {
        void reply.headers(testCase.reply.headers ?? {})
        return reply
          .status(testCase.reply.status)
          .send(testCase.reply.error ? { error: testCase.reply.error, message: 'probe' } : {})
      },
    })
    await app.ready()
    try {
      await app.inject(testCase.request ?? { method: testCase.method, url: testCase.url })
      expect(takeContractMismatches()).toEqual(testCase.expected)
    } finally {
      await app.close()
    }
  })
})
