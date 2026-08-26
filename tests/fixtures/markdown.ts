import { readFileSync } from 'node:fs'

/**
 * Just enough Markdown to read a table out of a document, so a table that restates something
 * the code already states can be asserted against it rather than proof-read by hand.
 *
 * Deliberately not a Markdown parser: it finds pipe tables and splits their cells. A cell
 * containing an escaped pipe would break it, and none of the tables it reads has one.
 */
export interface MarkdownTable {
  header: string[]
  rows: string[][]
}

const isRow = (line: string | undefined): boolean =>
  line !== undefined && line.trimStart().startsWith('|')

const isDivider = (line: string | undefined): boolean =>
  line !== undefined && /^\s*\|[\s:|-]+\|\s*$/.test(line)

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

export function tablesIn(path: string): MarkdownTable[] {
  const lines = readFileSync(new URL(path, import.meta.url), 'utf8').split('\n')
  const found: MarkdownTable[] = []

  for (let i = 0; i < lines.length; i += 1) {
    if (!isRow(lines[i]) || !isDivider(lines[i + 1])) continue

    const header = cells(lines[i]!)
    const rows: string[][] = []
    let cursor = i + 2
    while (isRow(lines[cursor])) {
      rows.push(cells(lines[cursor]!))
      cursor += 1
    }
    found.push({ header, rows })
    i = cursor - 1
  }

  return found
}

/**
 * The table whose header starts with these columns. Selecting by header rather than by
 * position means inserting a table above the one under test does not silently repoint the
 * assertion at the wrong rows.
 */
export function tableWithHeader(path: string, ...columns: string[]): MarkdownTable {
  const matches = tablesIn(path).filter((table) =>
    columns.every((column, index) => table.header[index] === column),
  )
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one table in ${path} with header [${columns.join(', ')}], found ${matches.length}`,
    )
  }
  return matches[0]!
}

/** Markdown emphasis around a value the document renders rather than quotes. */
export function unwrap(cell: string): string {
  return cell.replace(/^[`_*]+/, '').replace(/[`_*]+$/, '')
}
