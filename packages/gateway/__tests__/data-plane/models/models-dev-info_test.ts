import { describe, expect, test } from 'vitest';

import { toModelsDevInfo } from '../../../src/data-plane/models/models-dev-info.ts';
import type { PublicModel } from '@floway-dev/protocols/common';

const model = (overrides: Partial<PublicModel> = {}): PublicModel => ({
  id: 'model',
  object: 'model',
  type: 'model',
  display_name: 'Model',
  kind: 'chat',
  limits: {},
  endpoints: { openaiResponses: {} },
  opaqueBlobCompatibilityScope: { bindToUpstream: true },
  ...overrides,
});

describe('models.dev info envelope', () => {
  test('states text-only input as a trusted vision false and writes no reasoning for a model without it', () => {
    expect(toModelsDevInfo(model({
      limits: { max_output_tokens: 16_384 },
      chat: { modalities: { input: ['text'], output: ['text'] } },
    }))).toEqual({
      meta: {
        capabilities: { vision: false, vision_source: 'upstream' },
        models_dev: { name: 'Model', limit: { output: 16_384 }, modalities: { input: ['text'], output: ['text'] } },
      },
    });
  });

  test('restates budget reasoning as a budget option and adaptive reasoning without inventing options', () => {
    expect(toModelsDevInfo(model({ chat: { reasoning: { budget_tokens: { min: 1024, max: 32_000 } } } })).meta.models_dev).toEqual({
      name: 'Model',
      reasoning: true,
      reasoning_options: [{ type: 'budget_tokens', min: 1024, max: 32_000 }],
    });
    expect(toModelsDevInfo(model({ chat: { reasoning: { adaptive: true } } })).meta.models_dev).toEqual({ name: 'Model', reasoning: true });
  });
});
