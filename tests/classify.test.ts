// Address-bar routing: addresses open, questions go to the assistant, plain searches go to the web.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInput } from '../apps/raven-browser/src/renderer/ctx';

test('address bar: questions and coding requests go to the assistant', () => {
  for (const q of [
    'write me code for basic end to end 4 arthematic operations of two dgiits in c',
    'Write a C program for a linked list',
    'explain recursion in python',
    'how do I reverse a string in java',
    'what is a binary search tree?',
    'why does my code throw NullPointerException',
    'difference between stack and queue',
    'generate a basic javascript calculator',
    'is python faster than java?',
    'debug this java program',
  ]) {
    assert.equal(classifyInput(q), 'ai', q);
  }
});

test('address bar: addresses open as pages', () => {
  for (const q of ['google.com', 'https://example.com/a b', 'localhost:3000', '192.168.1.20:8080/x', 'mail.google.com', 'raven://settings', 'en.wikipedia.org/wiki/Raven']) {
    assert.equal(classifyInput(q), 'url', q);
  }
});

test('address bar: short plain searches go to the web', () => {
  for (const q of ['weather', 'cricket score', 'taj mahal', 'news today', 'python', 'best laptop 2026', 'raven bird']) {
    assert.equal(classifyInput(q), 'search', q);
  }
});
