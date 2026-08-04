/**
 * Corrections to the Swagger UI stylesheet.
 *
 * The descriptions in this API lean on inline `code` — `P1D`, `+02:00`, `start_time` — and
 * Swagger UI styles those with a background and vertical padding, which makes them taller
 * than the line box they sit in. At the default line height the boxes collide with the line
 * above, so a description with several code spans renders as overlapping text. Long spans
 * also refuse to wrap, pushing the paragraph past the right edge of the panel.
 *
 * Everything below fixes exactly that: room for the boxes, and permission to wrap.
 */
export const swaggerThemeCss = `
/*
 * Enough leading for an inline code box to sit inside its own line. .renderedMarkdown is
 * the wrapper Swagger UI puts around every description it renders — the API summary at the
 * top and each operation alike — so one rule covers both.
 */
.swagger-ui .renderedMarkdown p,
.swagger-ui .renderedMarkdown li,
.swagger-ui .info .description p,
.swagger-ui .info .description li,
.swagger-ui .opblock-description-wrapper p,
.swagger-ui .opblock-description-wrapper li {
  line-height: 1.85;
  overflow-wrap: anywhere;
}

/*
 * Any inline code span, whichever container it lands in. :not(pre) > code is what keeps
 * this away from example bodies and generated curl commands, where collapsing whitespace
 * would destroy the formatting.
 */
.swagger-ui :not(pre) > code {
  padding: 0 4px;
  line-height: inherit;
  white-space: normal;
  overflow-wrap: anywhere;
}

/* Bullets sat flush against the surrounding paragraphs. */
.swagger-ui .renderedMarkdown ul,
.swagger-ui .renderedMarkdown ol,
.swagger-ui .info .description ul,
.swagger-ui .info .description ol {
  margin: 0.7em 0;
  padding-left: 1.5em;
}

.swagger-ui .renderedMarkdown li,
.swagger-ui .info .description li {
  margin-bottom: 0.4em;
}

/* A very wide viewport stretches prose to unreadable line lengths. */
.swagger-ui .info .description,
.swagger-ui .opblock-description-wrapper .renderedMarkdown {
  max-width: 90ch;
}
`
