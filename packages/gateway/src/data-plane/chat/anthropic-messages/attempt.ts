import { anthropicMessagesInterceptors, anthropicMessagesCountTokensInterceptors } from './interceptors/index.ts';
import type { AnthropicMessagesInvocation } from './interceptors/types.ts';
import { createAnthropicMessagesBillableUsageReader } from './usage.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import { openaiChatCompletionsAttempt } from '../openai-chat-completions/attempt.ts';
import { openaiResponsesAttempt } from '../openai-responses/attempt.ts';
import { applyRulesToAnthropicBeta, applyRulesToUpstreamAnthropicMessages } from '../shared/alias-rules.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { providerStreamResultToExecuteResult } from '../shared/provider-stream-result.ts';
import { plainResultFromResponse } from '../shared/respond.ts';
import { SidecarDomain } from '../shared/sidecar-codec.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { captureFromDump, traverseTranslation } from '../shared/translate-traverse.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ModelCandidate, ExecuteResult, AnthropicMessagesUpstreamCallOptions, PlainResult, ProviderStreamResult } from '@floway-dev/provider';
import { internalErrorResult, providerModelOf, toInternalDebugError } from '@floway-dev/provider';
import { routeAnthropicMessages } from '@floway-dev/translate/anthropic-messages';

// `/v1/messages` generate prefers a native Anthropic Messages target, then the
// translated OpenAI Responses path, then the translated OpenAI Chat Completions path.
export const anthropicMessagesGenerateTarget = chatTargetPicker(['anthropicMessages', 'openaiResponses', 'openaiChatCompletions']);

// `count_tokens` has no translation path — only a native Anthropic Messages target
// satisfies the operation.
export const anthropicMessagesCountTokensTarget = chatTargetPicker(['anthropicMessages']);

export interface AnthropicMessagesAttemptArgs {
  readonly payload: AnthropicMessagesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly candidate: ModelCandidate;
  readonly headers: Headers;
  readonly anthropicBeta: readonly string[];
}

const buildAnthropicMessagesUpstreamCallOptions = (
  candidate: ModelCandidate,
  ctx: ChatGatewayCtx,
  headers: Headers,
  anthropicBeta: readonly string[],
): AnthropicMessagesUpstreamCallOptions => ({
  ...buildUpstreamCallOptions(candidate, ctx, headers),
  anthropicBeta,
});

const preflightAnthropicMessagesStream = async (
  result: Extract<ProviderStreamResult<AnthropicMessagesStreamEventEx>, { ok: true }>,
  abortController: AbortController,
): Promise<Extract<ProviderStreamResult<AnthropicMessagesStreamEventEx>, { ok: true }>> => {
  const iterator = result.events[Symbol.asyncIterator]();
  const buffered: ProtocolFrame<AnthropicMessagesStreamEventEx>[] = [];
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error('Upstream Anthropic Messages stream ended before message_start');
      buffered.push(next.value);
      if (next.value.type === 'done') throw new Error('Upstream Anthropic Messages stream ended before message_start');
      const event = next.value.event;
      if (event.type === 'ping') continue;
      if (event.type === 'error') throw new Error(`Upstream Anthropic Messages SSE error: ${event.error.type}: ${event.error.message}`);
      if (event.type !== 'message_start') {
        throw new Error(`Upstream Anthropic Messages stream started with invalid event: ${JSON.stringify(event)}`);
      }
      break;
    }
  } catch (error) {
    if (!abortController.signal.aborted) abortController.abort(error);
    throw error;
  }
  const events = (async function* () {
    yield* buffered;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  })();
  return { ...result, events };
};

export const anthropicMessagesAttempt = {
  generate: async (args: AnthropicMessagesAttemptArgs): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEventEx>>> => {
    const { payload: sourcePayload, ctx, candidate, headers: sourceHeaders, anthropicBeta } = args;
    const payload = { ...sourcePayload, model: candidate.model.id };
    const headers = new Headers(sourceHeaders);
    headers.delete('anthropic-beta');
    const targetApi = anthropicMessagesGenerateTarget.pick(candidate.model.endpoints);
    const invocation: AnthropicMessagesInvocation = {
      payload,
      candidate,
      targetApi,
      headers,
    };
    return await runInterceptors(invocation, ctx, anthropicMessagesInterceptors, async () => {
      if (targetApi === 'anthropicMessages') {
        if (candidate.rules !== undefined) applyRulesToUpstreamAnthropicMessages(invocation.payload, candidate.rules);
        const effectiveAnthropicBeta = candidate.rules !== undefined
          ? applyRulesToAnthropicBeta(anthropicBeta, candidate.rules)
          : anthropicBeta;
        const timeoutMs = candidate.rules?.anthropicFirstEventTimeoutMs;
        const timeoutController = timeoutMs !== undefined ? new AbortController() : undefined;
        let firstEventTimedOut = false;
        const timeoutHandle = timeoutController !== undefined
          ? setTimeout(() => {
              firstEventTimedOut = true;
              timeoutController.abort(new Error(`Anthropic Messages first event timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;
        const signal = timeoutController === undefined
          ? ctx.abortSignal
          : ctx.abortSignal === undefined
            ? timeoutController.signal
            : AbortSignal.any([ctx.abortSignal, timeoutController.signal]);
        const { model: _model, ...body } = invocation.payload;
        try {
          const rawProviderResult = await candidate.provider.instance.callAnthropicMessages(
            providerModelOf(candidate),
            body,
            signal,
            buildAnthropicMessagesUpstreamCallOptions(candidate, ctx, invocation.headers, effectiveAnthropicBeta),
          );
          const providerResult = timeoutController !== undefined && rawProviderResult.ok
            ? await preflightAnthropicMessagesStream(rawProviderResult, timeoutController)
            : rawProviderResult;
          return await providerStreamResultToExecuteResult(providerResult, candidate, targetApi, ctx, createAnthropicMessagesBillableUsageReader());
        } catch (error) {
          ctx.abortSignal?.throwIfAborted();
          if (firstEventTimedOut) {
            return internalErrorResult(504, toInternalDebugError(timeoutController?.signal.reason ?? error, targetApi), ctx.attempt.telemetry);
          }
          if (timeoutController !== undefined) {
            return internalErrorResult(502, toInternalDebugError(error, targetApi), ctx.attempt.telemetry);
          }
          throw error;
        } finally {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        }
      }
      if (targetApi === 'openaiResponses') {
        return await traverseTranslation(
          invocation.payload,
          p => routeAnthropicMessages(p).viaOpenAIResponses({ model: candidate.model.id, sidecarCodec: ctx.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn) }),
          translated => openaiResponsesAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers,
          }),
          captureFromDump(ctx.dump, targetApi),
        );
      }
      if (targetApi === 'openaiChatCompletions') {
        return await traverseTranslation(
          invocation.payload,
          p => routeAnthropicMessages(p).viaOpenAIChatCompletions({ model: candidate.model.id, sidecarCodec: ctx.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn) }),
          translated => openaiChatCompletionsAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers,
          }),
          captureFromDump(ctx.dump, targetApi),
        );
      }
      throw new Error(`anthropicMessagesAttempt.generate: unexpected targetApi '${targetApi as string}'`);
    });
  },

  countTokens: async (args: AnthropicMessagesAttemptArgs): Promise<PlainResult> => {
    const { payload: sourcePayload, ctx, candidate, headers: sourceHeaders, anthropicBeta } = args;
    const payload = { ...sourcePayload, model: candidate.model.id };
    const headers = new Headers(sourceHeaders);
    headers.delete('anthropic-beta');
    // `pick` here is contractually total — serve filtered with
    // `anthropicMessagesCountTokensTarget.canServe`, so a non-anthropic-messages candidate is
    // a contract breach.
    const targetApi = anthropicMessagesCountTokensTarget.pick(candidate.model.endpoints);
    const invocation: AnthropicMessagesInvocation = {
      payload,
      candidate,
      targetApi,
      headers,
    };
    const response = await runInterceptors(invocation, ctx, anthropicMessagesCountTokensInterceptors, async () => {
      if (candidate.rules !== undefined) applyRulesToUpstreamAnthropicMessages(invocation.payload, candidate.rules);
      const effectiveAnthropicBeta = candidate.rules !== undefined
        ? applyRulesToAnthropicBeta(anthropicBeta, candidate.rules)
        : anthropicBeta;
      const { model: _model, ...body } = invocation.payload;
      const { response } = await candidate.provider.instance.callAnthropicMessagesCountTokens(
        providerModelOf(candidate),
        body,
        ctx.abortSignal,
        buildAnthropicMessagesUpstreamCallOptions(candidate, ctx, invocation.headers, effectiveAnthropicBeta),
      );
      return response;
    });
    return await plainResultFromResponse(response, candidate.provider.upstreamId);
  },
};
