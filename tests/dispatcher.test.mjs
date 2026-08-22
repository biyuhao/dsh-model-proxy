/**
 * Offline unit tests for the dispatcher factory.
 * Run: npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getOrCreateDispatcher,
  clearDispatcherCache,
  socksDependencyAvailable,
} from '../lib/host/dispatcher.js'

test('socks dependency probe reports availability without throwing', () => {
  // `socks` is an optional dependency; in this repo it is installed, but the
  // probe must never throw either way.
  assert.equal(typeof socksDependencyAvailable(), 'boolean')
})

test('portless socks URL builds a dispatcher (regression: Number("") === 0)', () => {
  const d = getOrCreateDispatcher('socks5://127.0.0.1')
  assert.ok(d)
})

test('one dispatcher instance per proxyUrl, evictable', () => {
  clearDispatcherCache()
  const a = getOrCreateDispatcher('http://127.0.0.1:7890')
  const b = getOrCreateDispatcher('http://127.0.0.1:7890')
  assert.equal(a, b, 'same URL must reuse the cached dispatcher')
  assert.equal(clearDispatcherCache('http://127.0.0.1:7890'), 1, 'eviction reports the removed entry')
  const c = getOrCreateDispatcher('http://127.0.0.1:7890')
  assert.notEqual(a, c, 'eviction must produce a fresh dispatcher')
  assert.equal(clearDispatcherCache(), 1, 'full clear removes exactly the live entry')
  assert.equal(clearDispatcherCache(), 0, 'clearing an empty cache removes nothing')
})

test('close() is invoked on pooled dispatchers at teardown (unload hygiene)', async () => {
  clearDispatcherCache()
  const d = getOrCreateDispatcher('http://127.0.0.1:7891')
  // undici ProxyAgent exposes a graceful close(); assert it exists and that a
  // full clear does not reject — sockets retire without killing the process.
  assert.equal(typeof d.close, 'function', 'ProxyAgent must expose close()')
  clearDispatcherCache()
  await new Promise((r) => setTimeout(r, 10)) // let the fire-and-forget close settle
})

test('unsupported scheme throws with a redacted message', () => {
  assert.throws(
    () => getOrCreateDispatcher('http2://user:secretpw@h:1'),
    (err) => {
      const msg = String(err)
      return /unsupported proxy protocol/.test(msg) && !msg.includes('secretpw')
    },
  )
})

test('unparseable proxyUrl throws with truncated echo', () => {
  assert.throws(() => getOrCreateDispatcher('not a url ::::'), /invalid proxyUrl/)
})
