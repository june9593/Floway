import type { Context } from 'hono';

import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { prepareJsonModelRequest } from '../shared/passthrough-request.ts';
import { passthroughApiError, passthroughServe } from '../shared/passthrough-serve.ts';
import { readRequestBody, takeRequestBody } from '../shared/request-body.ts';
import { tokenUsage } from '../shared/telemetry/usage.ts';

export const systemOne = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const request = prepareJsonModelRequest(requestBody.bytes, 'SystemOne');
  const ctx = createGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), backgroundScheduler: backgroundSchedulerFromContext(c) });
  if (request.type === 'invalid') {
    ctx.dump?.error('gateway');
    return finalizeGatewayResponse(ctx, passthroughApiError(c, request.message, 400));
  }

  ctx.dump?.requestedModel(request.model);
  const response = await passthroughServe({
    c,
    ctx,
    sourceApi: '/systemone',
    operation: 'decision',
    model: request.model,
    kind: 'decision',
    modelServesEndpoint: model => model.endpoints.systemOne !== undefined,
    call: async (provider, model, opts) => {
      const { model: _model, ...body } = request.body;
      return await provider.instance.callSystemOne(model, body, undefined, opts);
    },
    response: {
      format: 'json',
      extractBilling: body => {
        if (!body || typeof body !== 'object' || !('usage' in body)) return null;
        const usage = body.usage;
        if (!usage || typeof usage !== 'object' || !('input_tokens' in usage) || typeof usage.input_tokens !== 'number') return null;
        const output = 'output_tokens' in usage && typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
        return tokenUsage({ input: usage.input_tokens, output });
      },
    },
  });
  return finalizeGatewayResponse(ctx, response);
};
