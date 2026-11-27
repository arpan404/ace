// SPDX-License-Identifier: Apache-2.0
//! Keeping levels earlier sessions learned (`learned-options.ts`).
//!
//! A live ACP session reports option sets only for the model it runs. Its catalog write
//! keeps what an earlier probe or session learned for every other model, so switching
//! models in one thread does not erase the rest's thinking levels.

use ace_protocol::generated::CatalogModel;

/// `models`, with a model's earlier efforts and raw data restored when the report has
/// none of its own and is not the default row.
pub fn keep_learned_options(
    models: Vec<CatalogModel>,
    previous: Option<&[std::sync::Arc<CatalogModel>]>,
) -> Vec<CatalogModel> {
    let Some(previous) = previous.filter(|previous| !previous.is_empty()) else {
        return models;
    };
    models
        .into_iter()
        .map(|mut model| {
            let Some(before) = previous.iter().find(|before| before.id.0 == model.id.0) else {
                return model;
            };
            if model.is_default.0 || !model.efforts.is_empty() || before.efforts.is_empty() {
                return model;
            }
            model.efforts = before.efforts.clone();
            if before.default_effort.is_some() {
                model.default_effort = before.default_effort.clone();
            }
            model.raw = before.raw.clone();
            model
        })
        .collect()
}

#[cfg(test)]
mod tests {
    //! Ports `packages/models/src/session-write-order.test.ts`: "two sessions reporting
    //! different models at once keep both models' thinking levels".

    use super::*;
    use ace_models::effort::{EffortValue, model_efforts};
    use ace_models::instance::ModelInstance;
    use ace_models::row::base;
    use ace_protocol::generated::ProviderKind;
    use serde_json::json;
    use std::sync::Arc;

    fn row(id: &str, levels: &[&str]) -> CatalogModel {
        let instance = ModelInstance::cli("one", ProviderKind::Acp, "", "/repo");
        let mut row = base(&instance, id, id, &json!({}));
        row.efforts = model_efforts(levels.iter().map(|level| EffortValue::id(level))).into();
        row
    }

    #[test]
    fn a_report_for_one_model_keeps_the_levels_learned_for_another() {
        let previous = vec![
            Arc::new(row("fast", &["low", "high"])),
            Arc::new(row("deep", &["low", "high", "max"])),
        ];
        let reported = keep_learned_options(
            vec![row("fast", &["low", "high"]), row("deep", &[])],
            Some(&previous),
        );
        let levels: Vec<String> = reported[1]
            .efforts
            .iter()
            .map(|effort| effort.id.0.clone())
            .collect();
        assert_eq!(levels, ["low", "high", "max"]);
        assert_eq!(reported[0].efforts.len(), 2);
    }

    #[test]
    fn the_default_row_and_a_row_with_levels_keep_their_own_report() {
        let mut default = row("fast", &[]);
        default.is_default = true.into();
        let previous = vec![Arc::new(row("fast", &["low", "high"]))];
        let kept = keep_learned_options(vec![default], Some(&previous));
        assert!(kept[0].efforts.is_empty());
        let reported = keep_learned_options(vec![row("fast", &["minimal"])], Some(&previous));
        assert_eq!(reported[0].efforts.len(), 1);
    }
}
