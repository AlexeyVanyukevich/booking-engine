import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface DstTransition {
  zone: string
  date: string
  kind: 'spring-forward' | 'fall-back'
  /** Real length of the local calendar day on `date` */
  hours: 23 | 25
  offsetBefore: string
  offsetAfter: string
}

interface DstFile {
  transitions: DstTransition[]
  zonesWithoutDst: string[]
}

/**
 * Loaded with readFileSync rather than a JSON import: import attributes behave differently
 * under `tsc --noEmit` with NodeNext and under Vite's transform, and a plain read works
 * identically in both.
 */
const file = JSON.parse(
  readFileSync(fileURLToPath(new URL('../data/dst-transitions.json', import.meta.url)), 'utf8'),
) as DstFile

export const dstTransitions: DstTransition[] = file.transitions
export const zonesWithoutDst: string[] = file.zonesWithoutDst

export const springForwards = dstTransitions.filter((t) => t.kind === 'spring-forward')
export const fallBacks = dstTransitions.filter((t) => t.kind === 'fall-back')

/** The date before a transition, useful for asserting that consecutive slots stay contiguous. */
export function dayBefore(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

export function dayAfter(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}
