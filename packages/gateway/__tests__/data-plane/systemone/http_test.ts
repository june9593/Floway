import { test } from 'vitest';

import { tokenCountsFromUsage } from '../../../src/repo/usage-metrics.ts';
import { flushAsyncWork, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals, assertExists, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

test('/v1/systemone routes Copilot decisions and preserves the upstream response', async () => {
  const { apiKey, repo } = await setupAppTest();
  const body = {
    model: 'microsoft-decision-1',
    state: 'The API returns 500 on every call.',
    questions: {
      team: {
        type: 'choice',
        instructions: 'Which team should handle this ticket?',
        criteria: { engineering: 'Software errors', billing: 'Charges and invoices' },
      },
      urgent: { type: 'noul', instructions: 'Is the API unavailable?' },
      severity: { type: 'score', instructions: 'How severe is the incident?', criteria: ['Minor', 'Critical'] },
    },
  };
  const upstreamBody = {
    model: 'microsoft-decision-1',
    answers: {
      team: { type: 'choice', choice: 'engineering', confidence: 0.8, probabilities: { engineering: 0.9, billing: 0.1 } },
      urgent: { type: 'noul', noul: 0.95 },
      severity: { type: 'score', score: 0.9, probabilities: { '0': 0.1, '1': 0.9 }, legend: { '0': 'Minor', '1': 'Critical' } },
    },
    usage: { input_tokens: 20, output_tokens: 3 },
  };
  let forwarded: unknown;

  await withMockedFetch(async request => {
    const url = new URL(request.url);
    if (url.pathname === '/copilot_internal/v2/token') {
      return jsonResponse({
        token: 'copilot-access-token',
        expires_at: 4102444800,
        refresh_in: 3600,
        endpoints: { api: 'https://api.individual.githubcopilot.com' },
      });
    }
    if (url.pathname === '/models') {
      return jsonResponse({
        object: 'list',
        data: [{ id: 'microsoft-decision-1', capabilities: { type: 'decisions' }, supported_endpoints: ['/v1/systemone'] }],
      });
    }
    if (url.pathname === '/v1/systemone') {
      forwarded = await request.json();
      return new Response(JSON.stringify(upstreamBody), {
        headers: { 'content-type': 'application/json', 'x-upstream-test': 'decision' },
      });
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestAppWithWarmModels('/v1/systemone', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
      body: JSON.stringify(body),
    });
    assertEquals(response.status, 200);
    assertEquals(response.headers.get('x-upstream-test'), 'decision');
    assertEquals(await response.json(), upstreamBody);
  });

  assertExists(forwarded);
  assertEquals(forwarded, body);
  await flushAsyncWork();
  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(tokenCountsFromUsage(usage[0]), { input: 20, output: 3 });
});

test('Copilot SystemOne models are listed as decisions and cannot be used for chat', async () => {
  const { apiKey } = await setupAppTest();
  await withMockedFetch(request => {
    const url = new URL(request.url);
    if (url.pathname === '/copilot_internal/v2/token') {
      return jsonResponse({
        token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600,
        endpoints: { api: 'https://api.individual.githubcopilot.com' },
      });
    }
    if (url.pathname === '/models') {
      return jsonResponse({
        object: 'list',
        data: [{ id: 'microsoft-decision-1', capabilities: { type: 'decisions' }, supported_endpoints: ['/v1/systemone'] }],
      });
    }
    throw new Error(`Unexpected upstream call ${request.url}`);
  }, async () => {
    const headers = { 'content-type': 'application/json', 'x-api-key': apiKey.key };
    const modelsResponse = await requestAppWithWarmModels('/v1/models', { headers });
    const models = await modelsResponse.json() as { data: Array<{ id: string; kind: string; endpoints: unknown }> };
    const decision = models.data.find(model => model.id === 'microsoft-decision-1');
    assertExists(decision);
    assertEquals(decision.kind, 'decision');
    assertEquals(decision.endpoints, { systemOne: {} });

    const chat = await requestAppWithWarmModels('/v1/chat/completions', {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'microsoft-decision-1', messages: [{ role: 'user', content: 'hello' }] }),
    });
    assertEquals(chat.status, 400);
  });
});

test('/v1/systemone preserves Copilot errors', async () => {
  const { apiKey } = await setupAppTest();
  await withMockedFetch(request => {
    const url = new URL(request.url);
    if (url.pathname === '/copilot_internal/v2/token') {
      return jsonResponse({
        token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600,
        endpoints: { api: 'https://api.individual.githubcopilot.com' },
      });
    }
    if (url.pathname === '/models') {
      return jsonResponse({
        object: 'list',
        data: [{ id: 'microsoft-decision-1', capabilities: { type: 'decisions' }, supported_endpoints: ['/v1/systemone'] }],
      });
    }
    if (url.pathname === '/v1/systemone') {
      return new Response('upstream rejected request', { status: 422, headers: { 'x-upstream-test': 'rejected' } });
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestAppWithWarmModels('/v1/systemone', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
      body: JSON.stringify({ model: 'microsoft-decision-1', state: 'test', questions: {} }),
    });
    assertEquals(response.status, 422);
    assertEquals(response.headers.get('x-upstream-test'), 'rejected');
    assertEquals(await response.text(), 'upstream rejected request');
  });
});
