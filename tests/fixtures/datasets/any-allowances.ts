export interface AnyAllowance {
  name: string
  /** Matched against the path from the repository root. */
  file: RegExp
  /** Matched against the line. */
  line: RegExp
}

// `any` is assembled rather than written, so the scan does not report its own dataset.
const ANY = 'any'

export const anyAllowances: AnyAllowance[] = [
  {
    name: "a migration's Kysely signature, which Kysely's migration API requires",
    file: /^src\/db\/migrations\/[^/]+\.ts$/,
    line: new RegExp(String.raw`\bKysely<${ANY}>`),
  },
]
