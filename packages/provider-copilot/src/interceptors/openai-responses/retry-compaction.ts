import type { CopilotOpenAIResponsesBoundaryInterceptor } from './types.ts';
import { isJsonObject } from '@floway-dev/protocols/common';
import { discardUpstreamResponse } from '@floway-dev/provider';

// Native compaction still requires its input to fit the model's window. Copilot
// can reject the accumulated reasoning replay before it can produce a summary;
// retry that failed compaction once without reasoning, keeping all other history.
// Ordinary turns and the first compaction attempt retain their reasoning state.
// https://developers.openai.com/api/docs/guides/compaction#standalone-compact-endpoint
// https://developers.openai.com/api/docs/guides/reasoning#keeping-reasoning-items-in-context
export const withCompactionRetried: CopilotOpenAIResponsesBoundaryInterceptor = async (ctx, _env, run) => {
  const result = await run();
  if (result.ok || result.response.status !== 400) return result;
  if (ctx.action !== 'compact' && !ctx.payload.input.some(item => item.type === 'compaction_trigger')) return result;

  const input = ctx.payload.input.filter(item => item.type !== 'reasoning');
  if (input.length === ctx.payload.input.length) return result;

  // Inspect a copy so unrelated errors retain their original bytes and headers.
  // Reading the copy to EOF releases the upstream transport; cancel the original
  // branch too when abandoning this response for the retry.
  const text = await result.response.clone().text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return result;
    throw error;
  }
  if (!isJsonObject(body) || !isJsonObject(body.error)) return result;
  const error = body.error;
  const contextWindowExceeded = error.code === 'context_length_exceeded'
    || (error.code === 'invalid_request_body'
      && error.message === 'Your input exceeds the context window of this model. Please adjust your input and try again.');
  if (!contextWindowExceeded) return result;

  await discardUpstreamResponse(result.response);
  ctx.payload = { ...ctx.payload, input };
  return await run();
};
