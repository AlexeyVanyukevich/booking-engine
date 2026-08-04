export interface ValidDurationCase {
  iso: string
  kind: 'day' | 'intraday'
  /** Expected length, in the unit natural to the kind */
  minutes?: number
  days?: number
  /** Canonical form, when it differs from the submitted string */
  canonical?: string
}

export const validIntradayDurations: ValidDurationCase[] = [
  { iso: 'PT1M', kind: 'intraday', minutes: 1 },
  { iso: 'PT5M', kind: 'intraday', minutes: 5 },
  { iso: 'PT15M', kind: 'intraday', minutes: 15 },
  { iso: 'PT30M', kind: 'intraday', minutes: 30 },
  { iso: 'PT45M', kind: 'intraday', minutes: 45 },
  { iso: 'PT1H', kind: 'intraday', minutes: 60 },
  { iso: 'PT1H30M', kind: 'intraday', minutes: 90 },
  { iso: 'PT2H', kind: 'intraday', minutes: 120 },
  { iso: 'PT8H', kind: 'intraday', minutes: 480 },
  { iso: 'PT12H30M', kind: 'intraday', minutes: 750 },
  { iso: 'PT23H', kind: 'intraday', minutes: 1380 },
  { iso: 'PT23H59M', kind: 'intraday', minutes: 1439 },
  { iso: 'PT0H30M', kind: 'intraday', minutes: 30, canonical: 'PT30M' },
  { iso: 'PT2H0M', kind: 'intraday', minutes: 120, canonical: 'PT2H' },
]

export const validDayDurations: ValidDurationCase[] = [
  { iso: 'P1D', kind: 'day', days: 1 },
  { iso: 'P2D', kind: 'day', days: 2 },
  { iso: 'P7D', kind: 'day', days: 7 },
  { iso: 'P30D', kind: 'day', days: 30 },
  { iso: 'P365D', kind: 'day', days: 365 },
  { iso: 'P366D', kind: 'day', days: 366 },
]

export const validDurations = [...validIntradayDurations, ...validDayDurations]

export interface InvalidDurationCase {
  iso: string
  reason: string
}

export const invalidDurations: InvalidDurationCase[] = [
  { iso: 'PT24H', reason: 'exactly a day, but a fixed 24 hours rather than anchor to anchor' },
  { iso: 'PT25H', reason: 'longer than any intraday window can be' },
  { iso: 'PT24H1M', reason: 'over the intraday ceiling' },
  { iso: 'PT0M', reason: 'zero length' },
  { iso: 'PT0H', reason: 'zero length' },
  { iso: 'PT0H0M', reason: 'zero length' },
  { iso: 'P0D', reason: 'zero length' },
  { iso: 'P367D', reason: 'beyond the 366-day ceiling' },
  { iso: 'P1M', reason: 'months vary in length' },
  { iso: 'P1Y', reason: 'years vary in length' },
  { iso: 'P1W', reason: 'weeks are not part of the accepted grammar' },
  { iso: 'P1DT2H', reason: 'mixes calendar days with clock components' },
  { iso: 'PT1S', reason: 'seconds are not part of the accepted grammar' },
  { iso: 'PT1H30S', reason: 'seconds are not part of the accepted grammar' },
  { iso: 'PT', reason: 'no components' },
  { iso: 'P', reason: 'no components' },
  { iso: '', reason: 'empty' },
  { iso: '1h', reason: 'not ISO-8601' },
  { iso: 'sixty minutes', reason: 'not ISO-8601' },
  { iso: 'PT-1H', reason: 'negative' },
  { iso: 'P-1D', reason: 'negative' },
  { iso: 'pt1h', reason: 'lowercase is not accepted' },
  { iso: ' PT1H', reason: 'leading whitespace' },
  { iso: 'PT1H ', reason: 'trailing whitespace' },
]
