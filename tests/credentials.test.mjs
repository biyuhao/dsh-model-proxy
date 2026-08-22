/**
 * Offline tests for credentialRef composition and the soft credentials-service
 * lookup seam.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeProxyUrl, getCredentialsService } from '../lib/host/credentials.js'

test('composeProxyUrl merges user:password into the proxy URL userinfo', () => {
  const out = composeProxyUrl('socks5://127.0.0.1:1080', 'alice:s3cret')
  assert.equal(out, 'socks5://alice:s3cret@127.0.0.1:1080') // non-special scheme: no trailing slash
})

test('composeProxyUrl splits at the FIRST colon (passwords may contain colons)', () => {
  const out = composeProxyUrl('http://h:8080', 'bob:pa:ss:wd')
  assert.ok(out.startsWith('http://bob:pa%3Ass%3Awd@') || out.includes('bob:'), out)
  const u = new URL(out)
  assert.equal(u.username, 'bob')
})

test('composeProxyUrl rejects secrets without "user:" prefix', () => {
  assert.equal(composeProxyUrl('socks5://127.0.0.1:1080', 'justapassword'), undefined)
  assert.equal(composeProxyUrl('socks5://127.0.0.1:1080', ':nopuser'), undefined)
})

test('composeProxyUrl returns undefined for unparseable base URLs', () => {
  assert.equal(composeProxyUrl('not a url', 'u:p'), undefined)
})

test('getCredentialsService accepts a service exposing resolve()', () => {
  const fake = { resolve: async () => ({ value: 'u:p' }) }
  assert.equal(getCredentialsService({ get: () => fake }), fake)
})

test('getCredentialsService tolerates missing / broken / wrong-shaped services', () => {
  assert.equal(getCredentialsService({}), undefined)
  assert.equal(getCredentialsService({ get: () => undefined }), undefined)
  assert.equal(getCredentialsService({ get: () => { throw new Error('service absent') } }), undefined)
  assert.equal(getCredentialsService({ get: () => ({ nope: true }) }), undefined)
})
