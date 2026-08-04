import {
  acceptedExceptions,
  rejectedExceptions,
  type ExceptionBodyCase,
  type RejectedExceptionCase,
} from '../datasets/exception-validation.js'
import { aDayBasedResource, aResource } from '../resources.js'
import { expectError, expectStatus, type ResourceKind, type Suite } from './types.js'

const resourceFor = (kind: ResourceKind) => (kind === 'day' ? aDayBasedResource() : aResource())
const DATE = '2026-07-20'

export const acceptedExceptionsSuite: Suite<ExceptionBodyCase> = {
  name: 'Exceptions',
  cases: acceptedExceptions,
  describe: (testCase) => `accepts ${testCase.name}`,
  run: async ({ api, newResource }, testCase) => {
    const id = await newResource(resourceFor(testCase.kind))
    return expectStatus(await api.putException(id, { date: DATE, ...testCase.body }), 200)
  },
}

export const rejectedExceptionsSuite: Suite<RejectedExceptionCase> = {
  name: 'Exceptions — rejections',
  cases: rejectedExceptions,
  describe: (testCase) => `rejects ${testCase.name}`,
  run: async ({ api, newResource }, testCase) => {
    const id = await newResource(resourceFor(testCase.kind))
    return expectError(
      await api.putException(id, { date: DATE, ...testCase.body }),
      testCase.expectedError,
    )
  },
}
