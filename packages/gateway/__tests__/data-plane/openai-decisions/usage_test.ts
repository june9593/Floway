import { test } from 'vitest';

import { tokenUsageFromOpenAIDecisionsBody } from '../../../src/data-plane/openai-decisions/usage.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('OpenAI Decisions usage separates cached and uncached input tokens', () => {
  assertEquals(tokenUsageFromOpenAIDecisionsBody({ usage: { input_tokens: 398, output_tokens: 0 } }), { input: 398 });
  assertEquals(tokenUsageFromOpenAIDecisionsBody({
    usage: { input_tokens: 398, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 10 }, output_tokens: 3 },
  }), { input: 288, input_cache_read: 100, input_cache_write: 10, output: 3 });
  assertEquals(tokenUsageFromOpenAIDecisionsBody({
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 11 }, output_tokens: 0 },
  }), null);
});
