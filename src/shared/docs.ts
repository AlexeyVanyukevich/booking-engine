/**
 * Builds an OpenAPI `description`. One function, because getting Markdown spacing right by
 * hand is a mistake nobody makes only once.
 *
 * Pass one argument per block:
 *
 * - a **string** is a paragraph
 * - an **array** is a bullet list; items already starting with `-` or `1.` keep their marker
 *
 * ```ts
 * md(
 *   'Replaces the whole schedule in one transaction.',
 *   ['Shape matches the duration.', 'No overlap on a weekday.'],
 *   'Weekdays are Monday = 0, Sunday = 6.',
 * )
 * ```
 *
 * Two spacing rules are the whole point, and they pull in opposite directions:
 *
 * - **Between blocks — a blank line.** Markdown reads a single newline as a space, so
 *   hand-wrapped lines joined with `\n` collapse into one very long line. That is what made
 *   the first version of these descriptions unreadable in the Swagger UI.
 * - **Inside a list — a single newline.** Blank lines between items produce a "loose" list
 *   with every item wrapped in a paragraph, and far more air than short items deserve.
 */
export type DescriptionBlock = string | readonly string[]

export function md(...blocks: DescriptionBlock[]): string {
  return blocks.map(renderBlock).join('\n\n')
}

const ALREADY_MARKED = /^\s*(\d+\.|[-*])\s/

function renderBlock(block: DescriptionBlock): string {
  if (typeof block === 'string') return block.trim()
  return block.map((item) => (ALREADY_MARKED.test(item) ? item : `- ${item}`)).join('\n')
}
