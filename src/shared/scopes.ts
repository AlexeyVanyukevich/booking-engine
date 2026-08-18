/**
 * The scope vocabulary. Deliberately flat: no scope implies another, and the check is set
 * membership. Nested tiers cannot express a partner channel that may create bookings and must
 * not read the tenant's calendar — whatever tier grants the write also grants the listing.
 *
 * This list is duplicated by the check constraint in migration 003, which hardcodes it because
 * an applied migration must not change meaning when a constant does. The integration suite
 * asserts the two agree.
 */
export const SCOPES = [
  'resources.read',
  'resources.write',
  'schedule.read',
  'schedule.write',
  'availability.read',
  'bookings.read',
  'bookings.write',
  'bookings.list',
] as const

export type Scope = (typeof SCOPES)[number]

/** Shown beside each checkbox in the console. Here rather than in a table, so a missing one is a compile error. */
export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  'resources.read': 'List resources and read one',
  'resources.write': 'Create, update and delete resources',
  'schedule.read': 'Read the weekly schedule and date exceptions',
  'schedule.write': 'Replace the schedule, set and clear exceptions',
  'availability.read': 'Compute free slots',
  'bookings.read': 'Read one booking by id',
  'bookings.write': 'Create bookings and move them through their lifecycle',
  'bookings.list': "List bookings by resource or across the tenant — the owner's calendar",
}

/**
 * Named bundles offered by the console. A preset name is never stored: it is expanded at issue
 * time and only the resulting set is written, so editing a preset tomorrow cannot change the
 * authority of a key already in the field.
 */
export const PRESETS = {
  widget: ['availability.read', 'resources.read'],
  site_backend: [
    'availability.read',
    'resources.read',
    'bookings.read',
    'bookings.write',
    'bookings.list',
  ],
  partner_channel: ['availability.read', 'resources.read', 'bookings.read', 'bookings.write'],
  reporting: [
    'resources.read',
    'schedule.read',
    'availability.read',
    'bookings.read',
    'bookings.list',
  ],
  back_office: [...SCOPES],
} as const satisfies Record<string, readonly Scope[]>

export type PresetName = keyof typeof PRESETS

export const PRESET_LABELS: Record<PresetName, string> = {
  widget: 'Widget',
  site_backend: 'Site backend',
  partner_channel: 'Partner channel',
  reporting: 'Reporting',
  back_office: 'Back office',
}

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value)
}

export function isPresetName(value: string): value is PresetName {
  return Object.hasOwn(PRESETS, value)
}

export function expandPreset(name: PresetName): Scope[] {
  return [...PRESETS[name]]
}
