// The master's assistant router: fixed rules for the obvious cases, so a changing free model cannot get them wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isErrand, openTarget } from '../apps/master-server/src/core/router';

test('router: "open / go to / visit <site>" opens the site without asking the AI', () => {
  assert.equal(openTarget('open youtube'), 'https://www.youtube.com');
  assert.equal(openTarget('go to github.com'), 'https://github.com');
  assert.equal(openTarget('Visit the wikipedia website'), 'https://www.wikipedia.com');
  assert.equal(openTarget('please open bbc.co.uk'), 'https://bbc.co.uk');
  for (const t of ['open my gmail and read the latest mail', 'what is a linked list', 'go to wikipedia and find when turing was born', 'open source licenses explained']) {
    assert.equal(openTarget(t), null, t);
  }
});

test('router: errands become tasks, questions never do', () => {
  for (const t of [
    'check my gmail for mails from the bank',
    'send a message to bob on whatsapp saying hi',
    'go to wikipedia and find when turing was born',
    'reply to Alex on telegram that I am late',
    'book a table for two at an italian place on opentable',
    'order a phone charger on amazon',
  ]) {
    assert.ok(isErrand(t), `should be a task: ${t}`);
  }
  for (const t of [
    'what is a linked list in C',
    'explain how to send data to a server in python',
    'how do I order a list in java?',
    'best budget laptops 2026 reviews',
    'write an email to my boss asking for leave',
    'linked list in C',
  ]) {
    assert.ok(!isErrand(t), `should not be a task: ${t}`);
  }
});
