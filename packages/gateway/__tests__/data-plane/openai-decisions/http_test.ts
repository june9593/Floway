import { test } from 'vitest';

import { tokenCountsFromUsage } from '../../../src/repo/usage-metrics.ts';
import { flushAsyncWork, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals, assertExists, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

test('/v1/decisions forwards the Copilot model and preserves its decision response', async () => {
  const { apiKey, repo } = await setupAppTest();
  const body = {
    model: 'gpt-6-luna-decisions',
    input: 'The box arrived crushed and the screen is cracked.',
    questions: [
      { type: 'predicate', name: 'damaged', instructions: 'Is the item damaged?' },
      {
        type: 'choice',
        name: 'department',
        instructions: 'Which department should handle this?',
        choices: [{ value: 'returns' }, { value: 'technical' }],
      },
      {
        type: 'score',
        name: 'severity',
        instructions: 'How severe is the damage?',
        levels: [{ label: 'none' }, { label: 'minor' }, { label: 'major' }],
      },
    ],
  };
  const upstreamBody = {
    model: 'gpt-6-luna',
    answers: [
      { type: 'predicate', name: 'damaged', probability: 1 },
      { type: 'choice', name: 'department', choice: 'returns', confidence: 1, probabilities: [{ value: 'returns', probability: 1 }, { value: 'technical', probability: 0 }] },
      { type: 'score', name: 'severity', score: 1.94, confidence: 0.91, probabilities: [{ value: 0, label: 'none', probability: 0.02 }, { value: 1, label: 'minor', probability: 0.02 }, { value: 2, label: 'major', probability: 0.96 }] },
    ],
    usage: { input_tokens: 398, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 10 }, output_tokens: 0 },
  };
  let forwarded: unknown;

  await withMockedFetch(async request => {
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
        data: [{ id: 'gpt-6-luna-decisions', capabilities: { type: 'decisions' }, supported_endpoints: ['/v1/decisions'] }],
      });
    }
    if (url.pathname === '/v1/decisions') {
      forwarded = await request.json();
      return new Response(JSON.stringify(upstreamBody), {
        headers: { 'content-type': 'application/json', 'x-upstream-test': 'decision' },
      });
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestAppWithWarmModels('/v1/decisions', {
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
  assertEquals(tokenCountsFromUsage(usage[0]), { input: 288, input_cache_read: 100, input_cache_write: 10 });
});

test('Copilot decision models expose only their advertised protocol and cannot be used for chat', async () => {
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
        data: [
          { id: 'gpt-6-luna-decisions', capabilities: { type: 'decisions' }, supported_endpoints: ['/v1/decisions'] },
          { id: 'microsoft-decision-1', capabilities: { type: 'decisions' }, supported_endpoints: ['/v1/systemone'] },
        ],
      });
    }
    throw new Error(`Unexpected upstream call ${request.url}`);
  }, async () => {
    const headers = { 'content-type': 'application/json', 'x-api-key': apiKey.key };
    const listing = await requestAppWithWarmModels('/v1/models', { headers });
    const { data } = await listing.json() as { data: Array<{ id: string; kind: string; endpoints: unknown }> };
    const luna = data.find(model => model.id === 'gpt-6-luna-decisions');
    const microsoft = data.find(model => model.id === 'microsoft-decision-1');
    assertExists(luna);
    assertExists(microsoft);
    assertEquals({ kind: luna.kind, endpoints: luna.endpoints }, { kind: 'decision', endpoints: { openaiDecisions: {} } });
    assertEquals({ kind: microsoft.kind, endpoints: microsoft.endpoints }, { kind: 'decision', endpoints: { systemOne: {} } });

    for (const [path, model, body] of [
      ['/v1/systemone', luna.id, { state: 'test', questions: {} }],
      ['/v1/decisions', microsoft.id, { input: 'test', questions: [] }],
      ['/v1/chat/completions', luna.id, { messages: [{ role: 'user', content: 'hello' }] }],
    ] as const) {
      const response = await requestAppWithWarmModels(path, {
        method: 'POST', headers, body: JSON.stringify({ model, ...body }),
      });
      assertEquals(response.status, 400);
    }
  });
});

test('/decisions preserves structured input and upstream errors', async () => {
  const { apiKey } = await setupAppTest();
  const body = {
    model: 'gpt-6-luna-decisions',
    input: [{ role: 'user', content: [{ type: 'input_json', data: { color: 'red' } }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }],
    questions: [{ type: 'predicate', name: 'red', instructions: 'Is it red?' }],
  };
  let forwarded: unknown;
  await withMockedFetch(async request => {
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
        data: [{ id: 'gpt-6-luna-decisions', capabilities: { type: 'decisions' }, supported_endpoints: ['/v1/decisions'] }],
      });
    }
    if (url.pathname === '/v1/decisions') {
      forwarded = await request.json();
      return new Response('upstream rejected request', { status: 422, headers: { 'x-upstream-test': 'rejected' } });
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestAppWithWarmModels('/decisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
      body: JSON.stringify(body),
    });
    assertEquals(response.status, 422);
    assertEquals(response.headers.get('x-upstream-test'), 'rejected');
    assertEquals(await response.text(), 'upstream rejected request');
  });
  assertEquals(forwarded, body);
});
