// Raven Wi-Fi link codes: format, typing tolerance, and the network both sides derive from a code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLinkCode, linkNetwork, normalizeLinkCode } from '../packages/security/src/link';
import { looksLikeErrand } from '../apps/raven-browser/src/renderer/ctx';

test('link code: format and no look-alike characters', () => {
  for (let i = 0; i < 200; i++) {
    const c = generateLinkCode();
    assert.match(c, /^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
    assert.equal(normalizeLinkCode(c), c);
  }
});

test('link code: accepts how people type it, rejects the rest', () => {
  assert.equal(normalizeLinkCode('k7qm2 xw4ph'), 'K7QM2-XW4PH');
  assert.equal(normalizeLinkCode(' K7QM2XW4PH '), 'K7QM2-XW4PH');
  assert.equal(normalizeLinkCode('K7QM2-XW4P'), null);
  assert.equal(normalizeLinkCode('K7QM2-XW4PHH'), null);
  assert.equal(normalizeLinkCode('K7QM0-XW4PH'), null);
  assert.equal(normalizeLinkCode(''), null);
  assert.equal(normalizeLinkCode('<script>'), null);
});

test('link network: same on both sides, valid WPA2, name reveals nothing of the code', () => {
  const a = linkNetwork('K7QM2-XW4PH');
  assert.deepEqual(linkNetwork('k7qm2xw4ph'), a);
  assert.match(a.ssid, /^Raven-[A-Z2-9]{4}$/);
  assert.ok(!a.ssid.includes('K7QM'));
  assert.ok(a.passphrase.length >= 8 && a.passphrase.length <= 63);
  assert.notDeepEqual(linkNetwork('K7QM2-XW4PJ'), a);
  assert.throws(() => linkNetwork('nope'));
});

test('instant answers: plain questions skip the router, errands do not', () => {
  assert.equal(looksLikeErrand('how does recursion work in python?'), false);
  assert.equal(looksLikeErrand('explain the difference between tcp and udp'), false);
  assert.equal(looksLikeErrand('book a train ticket to delhi tomorrow'), true);
  assert.equal(looksLikeErrand('what is the weather in hyderabad?'), true);
  assert.equal(looksLikeErrand('send an email to my team'), true);
});
