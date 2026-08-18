const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Every interpolation on every page goes through this, so a tenant named `<script>` is text.
 * One pass over the string, which is also what keeps `&` from being escaped twice: a
 * replace-per-character sequence starting anywhere but `&` would turn `<` into `&amp;lt;`.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]!)
}

/**
 * Matched to the Swagger UI theme, so the console and the documentation read as one product.
 * Inline: three pages do not justify a build step, and there is no asset pipeline to serve
 * a stylesheet from.
 */
const CSS = `
  :root { color-scheme: light dark; --fg: #1b1b1b; --muted: #6b6b6b; --line: #d8d8d8;
          --bg: #fff; --accent: #1f6feb; --accent-soft: #eef4ff; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e8e8e8; --muted: #9a9a9a; --line: #333; --bg: #151515; --accent: #58a6ff;
            --accent-soft: #16233a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem 1rem; background: var(--bg); color: var(--fg);
         font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 62rem; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 1.5rem; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .75rem; }
  a { color: var(--accent); }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
  .scroll { overflow-x: auto; margin-bottom: 1rem; }
  th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid var(--line);
           white-space: nowrap; vertical-align: top; }
  th { font-weight: 600; color: var(--muted); font-size: .78rem; text-transform: uppercase;
       letter-spacing: .04em; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  form { margin: 1rem 0; }
  label { display: block; margin: .5rem 0 .2rem; font-weight: 500; }
  fieldset label { display: inline-block; font-weight: 400; margin: 0; }
  input[type=text] { padding: .45rem .6rem; border: 1px solid var(--line); border-radius: 4px;
                     background: var(--bg); color: var(--fg); width: 100%; max-width: 26rem; }
  button { padding: .45rem .9rem; border: 1px solid var(--accent); border-radius: 4px;
           background: var(--accent); color: #fff; cursor: pointer; font: inherit; }
  button.secondary { background: transparent; color: var(--accent); }
  fieldset { border: 1px solid var(--line); border-radius: 4px; margin: 1rem 0; padding: .5rem 1rem 1rem; }
  fieldset fieldset { margin-top: .75rem; }
  legend { color: var(--muted); font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
  fieldset p { margin: .35rem 0; }
  .empty { color: var(--muted); font-style: italic; }
  .reveal { border: 1px solid var(--accent); background: var(--accent-soft);
            border-radius: 4px; padding: .5rem 1rem 1rem; margin: 1rem 0; }
  .muted { color: var(--muted); }
  .wrap { white-space: normal; }
`

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Booking Engine console</title>
<style>${CSS}</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>`
}
