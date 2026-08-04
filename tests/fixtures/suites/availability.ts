import {
  availabilityScenarios,
  type AvailabilityScenario,
} from '../datasets/availability-scenarios.js'
import type { Suite } from './types.js'

export const availabilitySuite: Suite<AvailabilityScenario> = {
  name: 'Availability',
  cases: availabilityScenarios,
  describe: (scenario) => scenario.name,
  run: async ({ api, newResource }, scenario) => {
    const id = await newResource(scenario.resource)
    await api.givenSchedule(id, scenario.schedule)
    if (scenario.exceptions) await api.givenExceptions(id, scenario.exceptions)
    if (scenario.deactivate) await api.patchResource(id, { is_active: false })

    const response = await api.getAvailability(id, scenario.from, scenario.to)
    if (response.statusCode !== 200) {
      return `expected 200, got ${response.statusCode}: ${response.body.slice(0, 200)}`
    }

    const actual = (response.json().slots as Array<{ start: string; end: string }>).map(
      (slot) => [slot.start, slot.end] as [string, string],
    )
    const wanted = scenario.expected

    if (actual.length !== wanted.length) {
      return `expected ${wanted.length} slots, got ${actual.length}`
    }
    for (let i = 0; i < wanted.length; i += 1) {
      if (actual[i]![0] !== wanted[i]![0] || actual[i]![1] !== wanted[i]![1]) {
        return `slot ${i}: expected ${wanted[i]!.join(' → ')}, got ${actual[i]!.join(' → ')}`
      }
    }
    return null
  },
}
