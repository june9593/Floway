import type { ChatModelInfo, ModelsDevModel, ModelsDevReasoningOption, PublicModel, PublicModelInfo, PublicModelLimits } from '@floway-dev/protocols/common';

// cc-switch fills a fetched model's context window, reasoning efforts and
// input modalities from the `info.meta` envelope on each model-list row,
// preferring it over its own models.dev lookup by model id.
// https://github.com/farion1231/cc-switch/blob/bb6c66b1df6c885edbe4343ac43ce81c561c8a29/src-tauri/src/services/model_fetch.rs#L40-L69
// https://github.com/farion1231/cc-switch/blob/bb6c66b1df6c885edbe4343ac43ce81c561c8a29/src/lib/modelMetadata.ts#L333-L403

const modelsDevLimit = (limits: PublicModelLimits): ModelsDevModel['limit'] => {
  const limit = {
    ...(limits.max_context_window_tokens === undefined ? {} : { context: limits.max_context_window_tokens }),
    ...(limits.max_prompt_tokens === undefined ? {} : { input: limits.max_prompt_tokens }),
    ...(limits.max_output_tokens === undefined ? {} : { output: limits.max_output_tokens }),
  };
  return Object.keys(limit).length === 0 ? undefined : limit;
};

const modelsDevReasoningOptions = (reasoning: ChatModelInfo['reasoning']): ModelsDevReasoningOption[] => [
  ...(reasoning?.effort === undefined || reasoning.effort.supported.length === 0
    ? []
    : [{ type: 'effort' as const, values: [...reasoning.effort.supported] }]),
  ...(reasoning?.budget_tokens === undefined ? [] : [{ type: 'budget_tokens' as const, ...reasoning.budget_tokens }]),
];

export const toModelsDevInfo = (model: PublicModel): PublicModelInfo => {
  const modalities = model.chat?.modalities;
  const reasoning = model.chat?.reasoning;
  const reasoningOptions = modelsDevReasoningOptions(reasoning);
  const reasons = reasoningOptions.length > 0 || reasoning?.adaptive === true || reasoning?.mandatory === true;
  const limit = modelsDevLimit(model.limits);
  return {
    meta: {
      ...(modalities === undefined ? {} : { capabilities: { vision: modalities.input.includes('image'), vision_source: 'upstream' as const } }),
      models_dev: {
        name: model.display_name,
        ...(limit === undefined ? {} : { limit }),
        ...(modalities === undefined ? {} : { modalities: { input: [...modalities.input], output: [...modalities.output] } }),
        ...(reasons ? { reasoning: true as const } : {}),
        ...(reasoningOptions.length === 0 ? {} : { reasoning_options: reasoningOptions }),
      },
    },
  };
};
