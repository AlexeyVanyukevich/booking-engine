export type BookingAction = 'confirm' | 'cancel' | 'complete' | 'no-show'

/** The state a booking is put into before the action is applied. */
export type StartingState =
  'held' | 'held_expired' | 'confirmed' | 'cancelled' | 'completed' | 'no_show' | 'expired'

export interface TransitionCase {
  from: StartingState
  action: BookingAction
  /** The HTTP status the action must return. */
  status: number
  /** The status the booking must carry afterwards, when the action succeeds. */
  becomes?: string
  /** The error code, when it does not. */
  error?: string
}

const ok = (from: StartingState, action: BookingAction, becomes: string): TransitionCase => ({
  from,
  action,
  status: 200,
  becomes,
})

const refused = (from: StartingState, action: BookingAction): TransitionCase => ({
  from,
  action,
  status: 409,
  error: 'invalid_state_transition',
})

const lapsed = (from: StartingState): TransitionCase => ({
  from,
  action: 'confirm',
  status: 410,
  error: 'hold_expired',
})

/**
 * The whole matrix, seven starting states by four actions. Adding a state or an action means
 * adding rows here — the test body does not change.
 *
 * `held_expired` is a hold whose `held_until` has passed but which no sweep has touched yet.
 * Every write opens a transaction that sweeps first, so it behaves exactly like `expired`.
 */
export const bookingTransitions: readonly TransitionCase[] = [
  // confirm
  ok('held', 'confirm', 'confirmed'),
  lapsed('held_expired'),
  ok('confirmed', 'confirm', 'confirmed'),
  refused('cancelled', 'confirm'),
  refused('completed', 'confirm'),
  refused('no_show', 'confirm'),
  lapsed('expired'),

  // cancel
  ok('held', 'cancel', 'cancelled'),
  refused('held_expired', 'cancel'),
  ok('confirmed', 'cancel', 'cancelled'),
  ok('cancelled', 'cancel', 'cancelled'),
  refused('completed', 'cancel'),
  refused('no_show', 'cancel'),
  refused('expired', 'cancel'),

  // complete
  refused('held', 'complete'),
  refused('held_expired', 'complete'),
  ok('confirmed', 'complete', 'completed'),
  refused('cancelled', 'complete'),
  ok('completed', 'complete', 'completed'),
  refused('no_show', 'complete'),
  refused('expired', 'complete'),

  // no-show
  refused('held', 'no-show'),
  refused('held_expired', 'no-show'),
  ok('confirmed', 'no-show', 'no_show'),
  refused('cancelled', 'no-show'),
  refused('completed', 'no-show'),
  ok('no_show', 'no-show', 'no_show'),
  refused('expired', 'no-show'),
]
