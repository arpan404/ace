use super::{ModelProjection, ModelProviderProjection};
use ace_core::ProviderKind;
use ace_protocol::provider_runtime::ProviderRuntimeModelsListResponse;

pub(super) fn model_registry_provider_kind(
    provider: &ModelProviderProjection,
) -> Option<ProviderKind> {
    ProviderKind::from_runtime_id(&provider.runtime_id)
        .or_else(|| ProviderKind::from_runtime_id(&provider.provider))
}

pub(super) fn model_provider_projection(
    response: ProviderRuntimeModelsListResponse,
) -> ModelProviderProjection {
    let models = response
        .catalog
        .models
        .into_iter()
        .map(|model| ModelProjection {
            id: model.id,
            display_name: model.display_name,
            provider: model.provider,
            family: model.family,
            context_window: model.capabilities.context_window,
            max_output_tokens: model.capabilities.max_output_tokens,
            supports_reasoning: model.capabilities.supports_reasoning,
            supports_vision: model.capabilities.supports_vision,
            supports_tools: model.capabilities.supports_tools,
            supports_computer_use: model.capabilities.supports_computer_use,
            supports_attachments: model.capabilities.supports_attachments,
        })
        .collect();

    ModelProviderProjection {
        runtime_id: response.runtime_id,
        display_name: response.display_name,
        provider: response.catalog.provider,
        models,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_runtime::models::{ProviderModel, ProviderModelCapabilities, ProviderModelCatalog};

    #[test]
    fn model_provider_projection_reads_catalog_capabilities() {
        let projection = model_provider_projection(ProviderRuntimeModelsListResponse {
            provider: ProviderKind::Codex,
            runtime_id: "codex".to_string(),
            display_name: "Codex".to_string(),
            catalog: ProviderModelCatalog {
                provider: "codex".to_string(),
                models: vec![ProviderModel {
                    id: "gpt-5".to_string(),
                    display_name: "GPT-5".to_string(),
                    provider: Some("openai".to_string()),
                    family: Some("gpt".to_string()),
                    capabilities: ProviderModelCapabilities {
                        context_window: Some(256_000),
                        max_output_tokens: Some(32_000),
                        supports_reasoning: true,
                        supports_vision: false,
                        supports_tools: true,
                        supports_computer_use: true,
                        supports_parallel_tool_calls: true,
                        supports_subagents: false,
                        supports_attachments: true,
                        default_reasoning_effort: Some("medium".to_string()),
                    },
                    metadata: Default::default(),
                    raw: serde_json::json!({ "id": "gpt-5" }),
                }],
                metadata: Default::default(),
                raw_payload: serde_json::json!({ "models": [] }),
            },
        });

        assert_eq!(projection.runtime_id, "codex");
        assert_eq!(projection.provider, "codex");
        assert_eq!(projection.models.len(), 1);
        assert_eq!(projection.models[0].display_name, "GPT-5");
        assert_eq!(projection.models[0].context_window, Some(256_000));
        assert!(projection.models[0].supports_tools);
        assert!(projection.models[0].supports_computer_use);
        assert!(projection.models[0].supports_attachments);
    }

    #[test]
    fn model_registry_provider_kind_uses_runtime_id_then_provider_fallback() {
        let provider = ModelProviderProjection {
            runtime_id: "openai-compatible".to_string(),
            display_name: "Claude Code".to_string(),
            provider: "claude-code".to_string(),
            models: Vec::new(),
        };

        assert_eq!(
            model_registry_provider_kind(&provider),
            Some(ProviderKind::ClaudeCode)
        );

        let provider = ModelProviderProjection {
            runtime_id: "codex".to_string(),
            display_name: "Codex".to_string(),
            provider: "unknown".to_string(),
            models: Vec::new(),
        };

        assert_eq!(
            model_registry_provider_kind(&provider),
            Some(ProviderKind::Codex)
        );
    }
}
