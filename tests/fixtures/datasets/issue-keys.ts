import type { PresetName } from '../../../src/shared/scopes.js'

export interface IssuedCase {
  name: string
  argv: string[]
  /** The presets the result names a key for, in any order. */
  issued: PresetName[]
}

export interface RefusedCase {
  name: string
  argv: string[]
  /** Matched against everything written to stderr. */
  refused: RegExp
}

const tenant = ['--tenant', 'acme']

export const issuedCases: IssuedCase[] = [
  { name: 'one preset', argv: [...tenant, '--preset', 'widget'], issued: ['widget'] },
  {
    name: 'several presets',
    argv: [...tenant, '--preset', 'site_backend', '--preset', 'back_office'],
    issued: ['site_backend', 'back_office'],
  },
  {
    name: 'every preset',
    argv: [
      ...tenant,
      ...['widget', 'site_backend', 'partner_channel', 'reporting', 'back_office'].flatMap(
        (preset) => ['--preset', preset],
      ),
    ],
    issued: ['widget', 'site_backend', 'partner_channel', 'reporting', 'back_office'],
  },
  {
    name: 'a preset named twice issues one key',
    argv: [...tenant, '--preset', 'site_backend', '--preset', 'site_backend'],
    issued: ['site_backend'],
  },
]

export const refusedCases: RefusedCase[] = [
  { name: 'an unknown preset', argv: [...tenant, '--preset', 'nope'], refused: /nope/ },
  {
    name: 'an unknown preset beside a known one',
    argv: [...tenant, '--preset', 'widget', '--preset', 'nope'],
    refused: /nope/,
  },
  { name: 'no preset', argv: [...tenant], refused: /--preset/ },
  { name: 'no tenant', argv: ['--preset', 'widget'], refused: /--tenant/ },
  { name: 'a blank tenant', argv: ['--tenant', '   ', '--preset', 'widget'], refused: /blank/ },
  {
    name: 'a tenant name over the limit',
    argv: ['--tenant', 'x'.repeat(101), '--preset', 'widget'],
    refused: /Tenant name/,
  },
  {
    name: 'an option the command does not take',
    argv: [...tenant, '--preset', 'widget', '--scope', 'resources.read'],
    refused: /--scope/,
  },
]
