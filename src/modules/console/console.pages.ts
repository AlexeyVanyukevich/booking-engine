import {
  PRESETS,
  PRESET_LABELS,
  SCOPES,
  SCOPE_DESCRIPTIONS,
  type PresetName,
} from '../../shared/scopes.js'
import type { ApiKeyRow, TenantRow } from '../tenants/tenant.repository.js'
import { escapeHtml, page } from './html.js'

export function formatDate(value: Date): string {
  return value.toISOString().replace('T', ' ').slice(0, 16)
}

export function tenantsPage(tenants: TenantRow[]): string {
  const rows = tenants
    .map(
      (tenant) => `<tr>
      <td><a href="/tenants/${escapeHtml(tenant.id)}/api-keys">${escapeHtml(tenant.name)}</a></td>
      <td class="mono muted">${escapeHtml(tenant.id)}</td>
      <td>${tenant.is_active ? 'active' : 'disabled'}</td>
      <td class="muted">${formatDate(tenant.created_at)}</td>
    </tr>`,
    )
    .join('')

  const table =
    tenants.length === 0
      ? '<p class="empty">No tenants yet. Create the first one below.</p>'
      : `<div class="scroll"><table><thead><tr><th>Name</th><th>Id</th><th>State</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table></div>`

  return page(
    'Tenants',
    `${table}
    <h2>New tenant</h2>
    <form method="post" action="/tenants">
      <label for="name">Name</label>
      <input type="text" id="name" name="name" maxlength="100" required autofocus>
      <p><button type="submit">Create tenant</button></p>
    </form>`,
  )
}

export function errorPage(status: number, message: string): string {
  return page(
    String(status),
    `<p>${escapeHtml(message)}</p><p><a href="/tenants">Back to tenants</a></p>`,
  )
}

/**
 * Shown once, on the redirect target. The value sits in a readonly input rather than in text
 * so it stays selectable with scripting off; the copy button only appears when a script is
 * there to make it work.
 */
function reveal(secret: string): string {
  return `<div class="reveal">
    <h2>Your new key</h2>
    <p>Copy it now. It is shown once and cannot be retrieved again — if it is lost, issue another and revoke this one.</p>
    <p><input type="text" class="mono" id="secret" value="${escapeHtml(secret)}" readonly size="60" aria-label="New API key"></p>
    <p><button type="button" class="secondary" id="copy" hidden>Copy</button></p>
    <script>
      var b = document.getElementById('copy');
      b.hidden = false;
      b.addEventListener('click', function () {
        navigator.clipboard.writeText(document.getElementById('secret').value);
      });
    </script>
  </div>`
}

/**
 * Presets first, because eight checkboxes are a worse question to put to an operator than
 * four names. The preset is expanded server-side and never stored: see `PRESETS`.
 */
function presetOptions(): string {
  const named = (Object.keys(PRESETS) as PresetName[])
    .map(
      (name, index) => `<p>
        <label><input type="radio" name="preset" value="${escapeHtml(name)}"${index === 0 ? ' checked' : ''}> ${escapeHtml(PRESET_LABELS[name])}</label>
        <span class="muted mono">${PRESETS[name].map(escapeHtml).join(' · ')}</span>
      </p>`,
    )
    .join('')

  const custom = SCOPES.map(
    (scope) => `<p>
      <label><input type="checkbox" name="scopes" value="${escapeHtml(scope)}"> <span class="mono">${escapeHtml(scope)}</span></label>
      <span class="muted">${escapeHtml(SCOPE_DESCRIPTIONS[scope])}</span>
    </p>`,
  ).join('')

  return `<fieldset><legend>Preset</legend>${named}
    <p><label><input type="radio" name="preset" value="custom"> Custom</label></p>
    <fieldset><legend>Custom scopes</legend>${custom}</fieldset>
  </fieldset>`
}

export function keysPage(tenant: TenantRow, keys: ApiKeyRow[], revealedSecret?: string): string {
  const rows = keys
    .map((key) => {
      const revoked = key.revoked_at !== null
      return `<tr>
        <td>${escapeHtml(key.name)}</td>
        <td class="mono">${escapeHtml(key.key_prefix)}</td>
        <td class="mono muted wrap">${key.scopes.map(escapeHtml).join(' · ')}</td>
        <td class="muted">${formatDate(key.created_at)}</td>
        <td class="muted">${key.last_used_at === null ? 'never' : formatDate(key.last_used_at)}</td>
        <td>${
          revoked
            ? `<span class="muted">revoked ${formatDate(key.revoked_at!)}</span>`
            : `<form method="post" action="/api-keys/${escapeHtml(key.id)}/revoke"><button class="secondary" type="submit">Revoke</button></form>`
        }</td>
      </tr>`
    })
    .join('')

  const table =
    keys.length === 0
      ? '<p class="empty">No keys yet. Issue the first one below.</p>'
      : `<div class="scroll"><table><thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`

  return page(
    `Keys · ${tenant.name}`,
    `<p><a href="/tenants">← All tenants</a></p>
    ${revealedSecret === undefined ? '' : reveal(revealedSecret)}
    ${table}
    <h2>New key</h2>
    <form method="post" action="/tenants/${escapeHtml(tenant.id)}/api-keys">
      <label for="keyname">Name</label>
      <input type="text" id="keyname" name="name" maxlength="100" required>
      ${presetOptions()}
      <p><button type="submit">Issue key</button></p>
    </form>`,
  )
}
