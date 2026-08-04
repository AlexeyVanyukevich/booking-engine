import {
  acceptedPatches,
  acceptedResources,
  rejectedPatches,
  rejectedResources,
  type AcceptedPatchCase,
  type AcceptedResourceCase,
  type RejectedPatchCase,
  type RejectedResourceCase,
} from '../datasets/resource-validation.js'
import { aResource } from '../resources.js'
import { expectError, expectFields, type Suite } from './types.js'

export const acceptedResourcesSuite: Suite<AcceptedResourceCase> = {
  name: 'Resource creation',
  cases: acceptedResources,
  describe: (testCase) => `accepts ${testCase.name}`,
  run: async ({ api, track }, testCase) => {
    const response = await api.createResource(aResource(testCase.overrides))
    if (response.statusCode !== 201) {
      return `expected 201, got ${response.statusCode}: ${response.body.slice(0, 200)}`
    }
    track(response.json().id)
    return expectFields(response, testCase.expected)
  },
}

export const rejectedResourcesSuite: Suite<RejectedResourceCase> = {
  name: 'Resource creation — rejections',
  cases: rejectedResources,
  describe: (testCase) => `rejects ${testCase.name}`,
  run: async ({ api }, testCase) =>
    expectError(
      await api.createResource({ ...aResource(), ...testCase.overrides }),
      testCase.expectedError,
    ),
}

export const acceptedPatchesSuite: Suite<AcceptedPatchCase> = {
  name: 'Resource update',
  cases: acceptedPatches,
  describe: (testCase) => testCase.name,
  run: async ({ api, newResource }, testCase) => {
    const id = await newResource(aResource(testCase.create))
    const response = await api.patchResource(id, testCase.patch)
    if (response.statusCode !== 200) {
      return `expected 200, got ${response.statusCode}: ${response.body.slice(0, 200)}`
    }
    return expectFields(response, testCase.expected)
  },
}

export const rejectedPatchesSuite: Suite<RejectedPatchCase> = {
  name: 'Resource update — rejections',
  cases: rejectedPatches,
  describe: (testCase) => `rejects ${testCase.name}`,
  run: async ({ api, newResource }, testCase) => {
    const id = await newResource(aResource(testCase.create))
    return expectError(await api.patchResource(id, testCase.patch), testCase.expectedError)
  },
}
