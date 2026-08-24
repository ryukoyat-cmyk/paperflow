import test from 'node:test';
import assert from 'node:assert/strict';
import { FULL_REVIEW_MAX_CHARS, MAX_BODY_CHARS, getDocumentPolicy } from '../assets/document-policy.js';

test('300,000자까지 교차검증한다', () => {
  assert.deepEqual(getDocumentPolicy(FULL_REVIEW_MAX_CHARS), {
    allowed: true, review: true, mode: 'reviewed', bodyChars: 300_000,
  });
});

test('300,001자부터 1차 번역만 수행한다', () => {
  assert.deepEqual(getDocumentPolicy(FULL_REVIEW_MAX_CHARS + 1), {
    allowed: true, review: false, mode: 'draft-only', bodyChars: 300_001,
  });
});

test('1,000,000자까지 허용한다', () => {
  assert.equal(getDocumentPolicy(MAX_BODY_CHARS).allowed, true);
  assert.equal(getDocumentPolicy(MAX_BODY_CHARS).review, false);
});

test('1,000,000자를 초과하면 차단한다', () => {
  assert.deepEqual(getDocumentPolicy(MAX_BODY_CHARS + 1), {
    allowed: false, review: false, mode: 'rejected', bodyChars: 1_000_001,
  });
});

test('유효하지 않은 글자 수를 거부한다', () => {
  assert.throws(() => getDocumentPolicy(-1), TypeError);
  assert.throws(() => getDocumentPolicy(Number.NaN), TypeError);
});
