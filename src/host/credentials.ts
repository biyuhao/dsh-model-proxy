/**
 * credentialRef support: compose a proxyUrl with a secret fetched from the
 * DSH credentials service, keeping plaintext passwords out of settings.yaml.
 *
 * The credentials service is a SOFT dependency (dsh-llm-deepseek follows the
 * same pattern): it is looked up via ctx.get('credentials') at runtime, never
 * declared in `inject`, so installs without the credentials package keep
 * working as long as no rule references a credentialRef.
 */

/**
 * Merge `secret` into `baseUrl`'s userinfo. Secret format is
 * "username:password" (split at the FIRST colon so passwords may contain
 * colons). Returns undefined for unparseable input.
 */
export function composeProxyUrl(baseUrl: string, secret: string): string | undefined {
  let u: URL
  try {
    u = new URL(baseUrl)
  } catch {
    return undefined
  }
  const sep = secret.indexOf(':')
  if (sep <= 0) return undefined // requires "user:pass"; empty user is ambiguous
  u.username = secret.slice(0, sep)
  u.password = secret.slice(sep + 1)
  return u.toString()
}

/** Minimal structural face of the DSH credentials service we rely on. */
export interface CredentialLookup {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/** Safely fetch the soft 'credentials' service; undefined when absent. */
export function getCredentialsService(ctx: unknown): CredentialLookup | undefined {
  try {
    const svc = (ctx as { get?(name: string): unknown }).get?.('credentials')
    if (
      svc !== undefined &&
      svc !== null &&
      typeof (svc as CredentialLookup).resolve === 'function'
    ) {
      return svc as CredentialLookup
    }
    return undefined
  } catch {
    return undefined
  }
}
