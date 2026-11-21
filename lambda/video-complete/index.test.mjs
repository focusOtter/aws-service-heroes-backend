import { test } from 'node:test'
import assert from 'node:assert/strict'
import { heroIdFromKey, withVideoLink } from './index.mjs'

test('heroIdFromKey reads the hero id from the Bedrock output key', () => {
  assert.equal(heroIdFromKey('videos/abc123/inv-9/output.mp4'), 'abc123')
  assert.equal(heroIdFromKey('videos/abc123/manifest.json'), null)
  assert.equal(heroIdFromKey('heroes/abc123.png'), null)
})

test('withVideoLink replaces the pending placeholder once', () => {
  const next = withVideoLink('img\n\n_Animation pending or unavailable._', 'https://cdn/x.mp4')
  assert.equal(next, 'img\n\n🎬 [Animated version](https://cdn/x.mp4)')
  assert.equal(withVideoLink(next, 'https://cdn/x.mp4'), null)
})

test('withVideoLink appends when there is no placeholder', () => {
  assert.equal(withVideoLink('img', 'https://cdn/x.mp4'), 'img\n\n🎬 [Animated version](https://cdn/x.mp4)')
})
