import { createHash } from 'node:crypto'

/**
 * Derives a stable, filesystem-safe key for a paired backend URL, used to namespace the confined
 * `work/<backendKey>/<productId>/` scratch tree so two backends can never collide on the same
 * `productId`. The shape is `<sanitized-host>-<sha256(normalizedUrl).slice(0,8)>`: the readable host
 * prefix aids debugging, and the hash guarantees distinctness across host, port, and path. The URL is
 * normalized first (host lowercased by the URL parser, trailing slash stripped) so cosmetic variants
 * of the same backend map to one key, while genuinely different host/port/path map to distinct keys.
 * The readable prefix is capped at 64 chars so a pathologically long host can never blow the path
 * segment; distinctness still comes from the digest (hashed over the FULL normalized URL, not the
 * capped prefix), so two long hosts sharing the first 64 chars stay distinct. The output is confined to
 * the `[a-z0-9-]` charset, so it is always a single safe path segment.
 *
 * @param backendUrl - An absolute backend URL (the paired backend's API origin).
 * @returns The `[a-z0-9-]` backend key.
 * @throws When `backendUrl` is not a valid absolute URL.
 */
export function backendKey(backendUrl: string): string {
  const url = new URL(backendUrl)
  const path = url.pathname.replace(/\/+$/, '')
  const normalized = `${url.protocol}//${url.host}${path}`
  // Cap the readable prefix at 64 chars, then re-strip a trailing dash in case the slice landed
  // mid-separator (so the `${host}-${digest}` join never yields a `--`).
  const host = url.hostname
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 8)
  return `${host}-${digest}`
}
