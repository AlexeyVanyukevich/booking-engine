import {
  acceptedSchedules,
  malformedSchedules,
  nonArrayScheduleBodies,
  rejectedSchedules,
  type RejectedScheduleCase,
  type ScheduleCase,
} from '../datasets/schedule-validation.js'
import { aDayBasedResource, aResource } from '../resources.js'
import { expectError, type ResourceKind, type Suite } from './types.js'
import type { ScheduleResponse } from '../bodies.js'

const resourceFor = (kind: ResourceKind) => (kind === 'day' ? aDayBasedResource() : aResource())

export const acceptedSchedulesSuite: Suite<ScheduleCase> = {
  name: 'Schedule',
  cases: acceptedSchedules,
  describe: (testCase) => `accepts ${testCase.name}`,
  run: async ({ api, newResource }, testCase) => {
    const id = await newResource(resourceFor(testCase.kind))
    const response = await api.putSchedule(id, testCase.rules)
    if (response.statusCode !== 200) {
      return `expected 200, got ${response.statusCode}: ${response.body.slice(0, 200)}`
    }
    const stored = response.json<ScheduleResponse>().length
    return stored === testCase.rules.length
      ? null
      : `expected ${testCase.rules.length} rules, got ${stored}`
  },
}

export const rejectedSchedulesSuite: Suite<RejectedScheduleCase> = {
  name: 'Schedule — rejections',
  cases: rejectedSchedules,
  describe: (testCase) => `rejects ${testCase.name}`,
  run: async ({ api, newResource }, testCase) => {
    const id = await newResource(resourceFor(testCase.kind))
    return expectError(await api.putSchedule(id, testCase.rules), testCase.expectedError)
  },
}

export const malformedSchedulesSuite: Suite<{ name: string; rules: unknown[] }> = {
  name: 'Schedule — malformed rules',
  cases: malformedSchedules,
  describe: (testCase) => `rejects ${testCase.name}`,
  run: async ({ api, newResource }, testCase) => {
    const id = await newResource(aResource())
    return expectError(await api.putSchedule(id, testCase.rules), 'validation_error')
  },
}

export const nonArrayScheduleBodiesSuite: Suite<{ name: string; body: unknown }> = {
  name: 'Schedule — malformed bodies',
  cases: nonArrayScheduleBodies,
  describe: (testCase) => `rejects a body that is ${testCase.name}`,
  run: async ({ api, newResource }, testCase) => {
    const id = await newResource(aResource())
    return expectError(await api.putScheduleJson(id, testCase.body), 'validation_error')
  },
}
