/**
 * Writes `openapi.json` at the repository root from the live document.
 *
 *   npm run openapi        (or ./run openapi)
 *
 * The file is committed so a consumer can generate its types without running the engine, and
 * so a contract change shows up in the diff of a pull request here rather than in a
 * consumer's failing build. `tests/integration/openapi.test.ts` fails when the two disagree,
 * which is what makes running this a step of changing a schema rather than an optional
 * courtesy.
 */
import { writeFile } from 'node:fs/promises'
import { generateOpenApiDocument, serializeOpenApiDocument } from '../src/shared/openapi.js'

const target = new URL('../openapi.json', import.meta.url)
const document = await generateOpenApiDocument()

await writeFile(target, serializeOpenApiDocument(document))

const routes = Object.values(document.paths as Record<string, object>).reduce(
  (total, methods) => total + Object.keys(methods).length,
  0,
)
process.stdout.write(`Wrote openapi.json — ${routes} operations\n`)
