/**
 * Files that once pointed into the old shared kit, by path from the repository root. Each was
 * rewritten when the kit became `charter`, and none may name the old package again.
 */
export const kitFreeFiles = [
  'package.json',
  'tsconfig.json',
  'testing/tsconfig.json',
  'run',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'tests/unit/documented-tables.test.ts',
  'tests/unit/run-bootstrap.test.ts',
  'README.md',
  'docs/architecture.md',
  'docs/conventions.md',
  'docs/backlog.md',
] as const
