import { test } from 'vitest';

import { withCompactionRetried } from '../../../src/interceptors/openai-responses/retry-compaction.ts';
import type { OpenAIResponsesBoundaryCtx } from '../../../src/interceptors/openai-responses/types.ts';
import type { ProviderOpenAIResponsesResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const invocation = (): OpenAIResponsesBoundaryCtx => ({
  payload: {
    model: 'gpt-test',
    input: [
      { type: 'message', role: 'user', content: 'Preserve the task.' },
      { type: 'reasoning', id: 'rs_previous', encrypted_content: 'opaque state', summary: [] },
      { type: 'compaction_trigger' },
    ],
  },
  headers: new Headers({ 'x-session-id': 'unchanged' }),
  model: stubProviderModel({ endpoints: { openaiResponses: {} } }),
  action: 'generate',
});

const contextError = JSON.stringify({ error: { code: 'context_length_exceeded', message: 'Too many input tokens.' } });

test('Copilot compaction retries the standard context error once and returns a second failure verbatim', async () => {
  const ctx = invocation();
  const original = structuredClone(ctx.payload);
  const first = new Response(contextError, { status: 400 });
  const secondBody = ' { "error": {"code":"context_length_exceeded","message":"Still too large"} }\n';
  const second = new Response(secondBody, { status: 400, headers: { 'x-upstream-request-id': 'second', 'content-type': 'application/json' } });
  let attempts = 0;
  const result = await withCompactionRetried(ctx, {}, async () => {
    attempts += 1;
    if (attempts === 1) {
      assertEquals(ctx.payload, original);
      return { action: 'generate', ok: false, response: first, modelKey: 'gpt-test' };
    }
    assertEquals(first.bodyUsed, true);
    assertEquals(ctx.payload, { ...original, input: [original.input[0], original.input[2]] });
    assertEquals([...ctx.headers], [['x-session-id', 'unchanged']]);
    return { action: 'generate', ok: false, response: second, modelKey: 'gpt-test' };
  });

  assertEquals(attempts, 2);
  if (result.ok) throw new Error('expected the second upstream failure');
  assertEquals(result.response === second, true);
  assertEquals(result.response.status, 400);
  assertEquals(result.response.headers.get('x-upstream-request-id'), 'second');
  assertEquals(await result.response.text(), secondBody);
});

test.each([
  { name: 'ordinary generation', mode: 'ordinary', status: 400, body: contextError },
  { name: 'compaction without reasoning', mode: 'no-reasoning', status: 400, body: contextError },
  { name: 'another 400 error', mode: 'compact', status: 400, body: '{"error":{"code":"invalid_request_body","message":"Invalid tool-call pairing."}}' },
  { name: 'context wording without the recognized code', mode: 'compact', status: 400, body: '{"error":{"code":"other","message":"Your input exceeds the context window of this model. Please adjust your input and try again."}}' },
  { name: 'only a similar context message', mode: 'compact', status: 400, body: '{"error":{"code":"invalid_request_body","message":"Your input exceeds the context window of this model."}}' },
  { name: 'non-400 context error', mode: 'compact', status: 429, body: contextError },
  { name: 'non-JSON error', mode: 'compact', status: 400, body: '<html>upstream failure</html>' },
  { name: 'unrecognized JSON error shape', mode: 'compact', status: 400, body: '{"code":"context_length_exceeded"}' },
])('Copilot does not retry $name or change the upstream failure', async ({ mode, status, body }) => {
  const ctx = invocation();
  if (mode === 'ordinary') ctx.payload.input.pop();
  if (mode === 'no-reasoning') ctx.payload.input.splice(1, 1);
  const original = structuredClone(ctx.payload);
  const response = new Response(body, { status, headers: { 'x-upstream-detail': 'preserve' } });
  const failure: ProviderOpenAIResponsesResult = { action: 'generate', ok: false, response, modelKey: 'gpt-test' };
  let attempts = 0;

  const result = await withCompactionRetried(ctx, {}, async () => {
    attempts += 1;
    return failure;
  });

  assertEquals(attempts, 1);
  assertEquals(result === failure, true);
  assertEquals(ctx.payload, original);
  assertEquals(response.bodyUsed, false);
  assertEquals(response.status, status);
  assertEquals(response.headers.get('x-upstream-detail'), 'preserve');
  assertEquals(await response.text(), body);
});

test('Copilot leaves an accepted compaction stream untouched even when it carries a failed event', async () => {
  const ctx = invocation();
  const original = structuredClone(ctx.payload);
  const events = (async function* () {
    yield { type: 'event' as const, event: { type: 'error' as const, code: 'context_length_exceeded', message: 'Stream error.' } };
  })();
  const success: ProviderOpenAIResponsesResult = { action: 'generate', ok: true, events, modelKey: 'gpt-test' };
  let attempts = 0;

  const result = await withCompactionRetried(ctx, {}, async () => {
    attempts += 1;
    return success;
  });

  assertEquals(attempts, 1);
  assertEquals(result === success, true);
  assertEquals(ctx.payload, original);
  if (!result.ok || result.action !== 'generate') throw new Error('expected the original stream');
  const frames = [];
  for await (const frame of result.events) frames.push(frame);
  assertEquals(frames, [{ type: 'event', event: { type: 'error', code: 'context_length_exceeded', message: 'Stream error.' } }]);
});
