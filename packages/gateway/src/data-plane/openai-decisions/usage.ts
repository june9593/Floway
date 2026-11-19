import type { TokenUsage } from '../../repo/types.ts';
import { tokenUsage } from '../shared/telemetry/usage.ts';
import { splitInclusiveInputTokens } from '@floway-dev/protocols/common';

const isTokenCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const tokenUsageFromOpenAIDecisionsBody = (body: unknown): TokenUsage | null => {
  if (!body || typeof body !== 'object' || !('usage' in body)) return null;
  const usage = body.usage;
  if (!usage || typeof usage !== 'object' || !('input_tokens' in usage) || !isTokenCount(usage.input_tokens)) return null;
  const output = 'output_tokens' in usage ? usage.output_tokens : 0;
  if (!isTokenCount(output)) return null;
  const details = 'input_tokens_details' in usage ? usage.input_tokens_details : undefined;
  if (details !== undefined && (!details || typeof details !== 'object')) return null;
  const read = details && 'cached_tokens' in details ? details.cached_tokens : 0;
  const write = details && 'cache_write_tokens' in details ? details.cache_write_tokens : 0;
  if (!isTokenCount(read) || !isTokenCount(write) || read + write > usage.input_tokens) return null;
  const { input, cacheRead, cacheWrite } = splitInclusiveInputTokens(usage.input_tokens, read, write);
  return tokenUsage({ input, input_cache_read: cacheRead, input_cache_write: cacheWrite, output });
};
