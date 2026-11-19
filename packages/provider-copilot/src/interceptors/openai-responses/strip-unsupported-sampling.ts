import type { OpenAIResponsesBoundaryCtx } from './types.ts';

// Copilot's GPT-5.6 `/responses` models reject non-default `temperature` and
// any `top_p` while reasoning is active, while their `/models` entries expose
// no sampling capability bit. Direct probes on 2026-09-03 verified the same
// behavior for all three ids; they accept both fields with `effort: "none"`
// and accept `temperature: 1` with reasoning active. Keep that exact observed
// matrix at the Copilot boundary. Translation must preserve these standard
// Responses fields for other providers.
//
// References:
// - https://developers.openai.com/api/docs/guides/latest-model
// - https://github.com/caozhiyuan/copilot-api/blob/b16e01909e747b5ad49ce38137a6c1453e0052a6/src/routes/responses/handler.ts
// - https://github.com/BerriAI/litellm/blob/ed9d29a9b45d433db0c629bee9550f35980f00cb/litellm/llms/openai/responses/transformation.py
const COPILOT_GPT_5_6_MODELS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
]);

export const withUnsupportedSamplingStripped = async <TResult>(
  ctx: OpenAIResponsesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  if (COPILOT_GPT_5_6_MODELS.has(ctx.model.id) && ctx.payload.reasoning?.effort !== 'none') {
    const payload = { ...ctx.payload };
    if (payload.temperature !== 1) delete payload.temperature;
    delete payload.top_p;
    ctx.payload = payload;
  }

  return await run();
};
