import type { Context } from 'hono';

import { tokenUsageFromOpenAIDecisionsBody } from './usage.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { prepareJsonModelRequest } from '../shared/passthrough-request.ts';
import { passthroughApiError, passthroughServe } from '../shared/passthrough-serve.ts';
import { readRequestBody, takeRequestBody } from '../shared/request-body.ts';

export const openaiDecisions = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const request = prepareJsonModelRequest(requestBody.bytes, 'OpenAI Decisions');
  const ctx = createGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), backgroundScheduler: backgroundSchedulerFromContext(c) });
  if (request.type === 'invalid') {
    ctx.dump?.error('gateway');
    return finalizeGatewayResponse(ctx, passthroughApiError(c, request.message, 400));
  }

  ctx.dump?.requestedModel(request.model);
  const response = await passthroughServe({
    c,
    ctx,
    sourceApi: '/decisions',
    operation: 'decision',
    model: request.model,
    kind: 'decision',
    modelServesEndpoint: model => model.endpoints.openaiDecisions !== undefined,
    call: async (provider, model, opts) => {
      const { model: _model, ...body } = request.body;
      return await provider.instance.callOpenAIDecisions(model, body, undefined, opts);
    },
    response: { format: 'json', extractBilling: tokenUsageFromOpenAIDecisionsBody },
  });
  return finalizeGatewayResponse(ctx, response);
};
