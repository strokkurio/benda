// Run: node --test packages/core/test/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explainError } from '../src/agents.mjs';

const IMAGES =
  'litellm.BadRequestError: OpenAIException - At most 4 image(s) may be provided in one prompt. (parameter=image). Received Model Group=local/qwen\nAvailable Model Group Fallbacks=None';

test('a known provider error gets its cause and next step first, the raw text as details', () => {
  const text = explainError(IMAGES, { shared: true });
  assert.match(text, /^The model accepts at most 4 images per prompt\. This shared session/);
  assert.match(text, /↺, then run the task again with ↻/);
  assert.ok(text.endsWith(`Details: ${IMAGES}`));
  assert.doesNotMatch(explainError(IMAGES), /shared session/);
});

test('other kinds are told apart, an unknown error stays as it is', () => {
  assert.match(explainError('Error: connect ECONNREFUSED 127.0.0.1:11434'), /^The model server cannot be reached/);
  assert.match(explainError('400 This model\'s maximum context length is 32768 tokens'), /^The task with the project rules/);
  assert.match(explainError('429 Too Many Requests'), /rate limit/);
  assert.equal(explainError('Something else broke'), 'Something else broke');
  assert.match(explainError('Something else broke', { shared: true }), /\n\nIf the shared session is gone/);
});
