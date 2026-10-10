import { COUNTED, SOMETIMES_COUNTED } from './rate-limit.js'

export interface DocumentedHeadersCase {
  method: string
  /** As the document writes it: `/resources/{id}`. */
  path: string
  status: string
  /** header name → whether the document marks it `required`. Empty: it declares none. */
  headers: Record<string, boolean>
}

export const documentedHeadersCases: DocumentedHeadersCase[] = [
  { method: 'get', path: '/health', status: '200', headers: COUNTED },
  { method: 'post', path: '/resources/{id}/bookings', status: '201', headers: COUNTED },
  { method: 'delete', path: '/resources/{id}', status: '204', headers: COUNTED },
  { method: 'get', path: '/resources/{id}', status: '400', headers: COUNTED },
  { method: 'get', path: '/resources', status: '401', headers: { 'www-authenticate': true } },
  { method: 'get', path: '/resources', status: '403', headers: {} },
  { method: 'get', path: '/resources/{id}', status: '404', headers: COUNTED },
  { method: 'post', path: '/resources/{id}/bookings', status: '409', headers: COUNTED },
  { method: 'post', path: '/bookings/{id}/confirm', status: '410', headers: COUNTED },
  { method: 'post', path: '/resources', status: '413', headers: COUNTED },
  { method: 'post', path: '/resources', status: '415', headers: COUNTED },
  { method: 'get', path: '/health', status: '429', headers: { 'retry-after': true, ...COUNTED } },
  {
    method: 'get',
    path: '/resources',
    status: '429',
    headers: { 'retry-after': true, ...COUNTED },
  },
  { method: 'get', path: '/resources', status: '500', headers: SOMETIMES_COUNTED },
  {
    method: 'post',
    path: '/bookings/{id}/confirm',
    status: '503',
    headers: { 'retry-after': true, ...COUNTED },
  },
]
