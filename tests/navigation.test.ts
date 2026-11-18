// Zoom steps, the Google robot-check fallback, and the Google sign-in compatibility headers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { googleBlockedQuery, nextZoom } from '../apps/raven-browser/src/main/navhelpers';
import { firefoxUserAgent, isSignInUrl, signInHeaders } from '../packages/shared/src/signin';

test('zoom: Chrome-like steps, clamped at both ends', () => {
  assert.equal(nextZoom(1, 'in'), 1.1);
  assert.equal(nextZoom(1, 'out'), 0.9);
  assert.equal(nextZoom(1.1, 'in'), 1.25);
  assert.equal(nextZoom(0.9, 'out'), 0.8);
  assert.equal(nextZoom(1.37, 'reset'), 1);
  assert.equal(nextZoom(5, 'in'), 5);
  assert.equal(nextZoom(0.25, 'out'), 0.25);
  // An odd value (from Ctrl+wheel elsewhere) snaps to the next real step.
  assert.equal(nextZoom(1.05, 'in'), 1.1);
  assert.equal(nextZoom(1.05, 'out'), 1);
});

test('Google robot check: the interrupted search is recovered, other pages are left alone', () => {
  const sorry = 'https://www.google.com/sorry/index?continue=' + encodeURIComponent('https://www.google.com/search?q=linked+list+in+c&hl=en') + '&q=EgQ';
  assert.equal(googleBlockedQuery(sorry), 'linked list in c');
  assert.equal(googleBlockedQuery('https://www.google.co.in/sorry/index?continue=' + encodeURIComponent('https://www.google.co.in/search?q=raven')), 'raven');
  assert.equal(googleBlockedQuery('https://www.google.com/search?q=raven'), null);
  assert.equal(googleBlockedQuery('https://www.google.com/sorry/index?continue=' + encodeURIComponent('https://mail.google.com/')), null);
  assert.equal(googleBlockedQuery('https://example.com/sorry/index?continue=https://www.google.com/search?q=x'), null);
  assert.equal(googleBlockedQuery('not a url'), null);
});

test('Google sign-in: only sign-in pages present as Firefox, without Chromium client hints', () => {
  assert.ok(isSignInUrl('https://accounts.google.com/v3/signin/identifier?continue=x'));
  assert.ok(isSignInUrl('https://accounts.google.co.in/ServiceLogin'));
  assert.ok(isSignInUrl('https://accounts.youtube.com/accounts/SetSID'));
  assert.ok(!isSignInUrl('https://mail.google.com/mail/u/0/'));
  assert.ok(!isSignInUrl('https://www.google.com/search?q=accounts.google.com'));
  assert.ok(!isSignInUrl('https://accounts.google.com.evil.example/'));
  const h = signInHeaders({ 'User-Agent': 'Mozilla/5.0 Chrome/156', 'sec-ch-ua': '"Chromium";v="156"', 'Sec-CH-UA-Platform': '"Windows"', Accept: 'text/html' }, 'win32');
  assert.equal(h['User-Agent'], firefoxUserAgent('win32'));
  assert.ok(/Firefox\/\d+/.test(h['User-Agent']) && !/Chrome|Electron/.test(h['User-Agent']));
  assert.equal(Object.keys(h).filter((k) => /^sec-ch-ua/i.test(k)).length, 0);
  assert.equal(h.Accept, 'text/html');
  assert.ok(firefoxUserAgent('darwin').includes('Macintosh'));
});
