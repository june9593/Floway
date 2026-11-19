import { test } from 'vitest';

import { withUnsupportedSamplingStripped } from '../../../src/interceptors/openai-responses/strip-unsupported-sampling.ts';
import type { OpenAIResponsesBoundaryCtx } from '../../../src/interceptors/openai-responses/types.ts';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assertEquals, assertFalse, stubProviderModel } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ProviderStreamResult<OpenAIResponsesStreamEventEx>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test', headers: new Headers() });

const invocation = (model: string): OpenAIResponsesBoundaryCtx => ({
  payload: {
    model,
    input: [{ type: 'message', role: 'user', content: 'hello' }],
    temperature: 0,
    top_p: 1,
  },
  headers: new Headers(),
  model: stubProviderModel({ id: model, endpoints: { openaiResponses: {} } }),
  action: 'generate',
});

test('drops sampling fields rejected by every Copilot GPT-5.6 model while reasoning is active', async () => {
  for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    const ctx = invocation(model);
    ctx.payload.reasoning = { effort: 'xhigh' };

    await withUnsupportedSamplingStripped(ctx, stubRequest, okEvents);

    assertFalse('temperature' in ctx.payload);
    assertFalse('top_p' in ctx.payload);
    assertEquals(ctx.payload.input, [{ type: 'message', role: 'user', content: 'hello' }]);
  }
});

test('preserves sampling fields when GPT-5.6 reasoning is disabled', async () => {
  const ctx = invocation('gpt-5.6-sol');
  ctx.payload.reasoning = { effort: 'none' };

  await withUnsupportedSamplingStripped(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.temperature, 0);
  assertEquals(ctx.payload.top_p, 1);
});

test('preserves the default temperature but drops top_p while GPT-5.6 reasoning is active', async () => {
  const ctx = invocation('gpt-5.6-sol');
  ctx.payload.reasoning = { effort: 'xhigh' };
  ctx.payload.temperature = 1;

  await withUnsupportedSamplingStripped(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.temperature, 1);
  assertFalse('top_p' in ctx.payload);
});

test('preserves sampling fields for models outside the probed GPT-5.6 family', async () => {
  const ctx = invocation('gpt-test');

  await withUnsupportedSamplingStripped(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.temperature, 0);
  assertEquals(ctx.payload.top_p, 1);
});
