// SPDX-License-Identifier: Apache-2.0
//! Shared cached rows as one immutable value.
//!
//! `packages/models/src/freeze.ts` deep-freezes a row before a picker or an embedded
//! caller can reach it. Rust's ownership is the freeze: a value nobody holds `&mut` to
//! cannot change, and an [`Arc`] gives every caller the same immutable row for the
//! price of a refcount. [`FrozenCatalog`] does the same for a page of rows, so a
//! refreshed catalog is swapped in one pointer, never rewritten under a reader.
//!
//! The TypeScript freezes `serviceTiers` (and each tier's parameters), `efforts`,
//! `inputModalities`, `raw`, `source` and `aliases` as well; here those are owned
//! fields of the same [`CatalogModel`], so freezing the row freezes all of them.

use std::sync::Arc;

use ace_protocol::generated::CatalogModel;

/// One shared catalog row. Cloning it never copies the row.
pub type FrozenModel = Arc<CatalogModel>;

/// A row another caller may keep: the Rust form of `freezeCatalogModel`.
pub fn freeze_catalog_model(model: CatalogModel) -> FrozenModel {
    Arc::new(model)
}

/// A catalog page shared with every reader; replacing it swaps one [`Arc`].
#[derive(Debug, Clone)]
pub struct FrozenCatalog {
    rows: Arc<[CatalogModel]>,
}

impl FrozenCatalog {
    /// Freezes `models` as one shared page.
    pub fn new(models: Vec<CatalogModel>) -> Self {
        Self {
            rows: Arc::from(models),
        }
    }

    /// The rows, borrowed from the shared page.
    pub fn models(&self) -> &[CatalogModel] {
        &self.rows
    }

    /// The shared page itself, for a caller that keeps it past this catalog.
    pub fn shared(&self) -> Arc<[CatalogModel]> {
        Arc::clone(&self.rows)
    }

    /// One row as its own shared handle.
    pub fn model(&self, index: usize) -> Option<FrozenModel> {
        self.rows.get(index).cloned().map(Arc::new)
    }

    /// How many rows the page holds.
    pub fn len(&self) -> usize {
        self.rows.len()
    }

    /// Whether the page is empty.
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
}

#[cfg(test)]
mod tests {
    //! `freeze.ts` has no TypeScript test file; these prove the boundary it exists for:
    //! one shared row, one shared page, and nested collections that survive freezing.
    //! The behaviour is what a picker relies on — a cached row it holds cannot change
    //! under it, and a refresh is a new page rather than a rewrite of the old one.

    use super::*;
    use ace_protocol::generated::ProviderKind;
    use serde_json::json;

    fn model(id: &str) -> CatalogModel {
        let instance =
            crate::instance::ModelInstance::cli("account", ProviderKind::Codex, "", "/repo");
        crate::row::base(&instance, id, id, &json!({ "status": "active" }))
    }

    #[test]
    fn a_frozen_row_is_one_shared_value() {
        let frozen = freeze_catalog_model(model("gpt-6.1-sol"));
        let same = Arc::clone(&frozen);
        assert!(Arc::ptr_eq(&frozen, &same));
        assert_eq!(frozen.id.0, "gpt-6.1-sol");
        assert_eq!(same.id.0, "gpt-6.1-sol");
        assert_eq!(Arc::strong_count(&frozen), 2);
    }

    #[test]
    fn a_frozen_catalog_shares_its_page_without_copying() {
        let catalog = FrozenCatalog::new(vec![model("a"), model("b")]);
        let same = catalog.clone();
        assert!(Arc::ptr_eq(&catalog.shared(), &same.shared()));
        assert_eq!(catalog.len(), 2);
        assert_eq!(
            catalog
                .models()
                .iter()
                .map(|model| model.id.0.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(
            catalog.model(1).map(|model| model.id.0.clone()),
            Some("b".to_owned())
        );
        assert!(FrozenCatalog::new(Vec::new()).is_empty());
    }

    #[test]
    fn nested_collections_survive_freezing_inside_the_same_value() {
        use crate::effort::model_efforts;
        let mut row = model("m");
        row.efforts = model_efforts([crate::effort::EffortValue::id("low")]).into();
        let frozen = freeze_catalog_model(row);
        assert_eq!(frozen.efforts.len(), 1);
        assert_eq!(frozen.efforts[0].id.0, "low");
        assert!(frozen.raw.json.contains("active"));
        let row = match Arc::try_unwrap(frozen) {
            Ok(row) => row,
            Err(shared) => (*shared).clone(),
        };
        let page = FrozenCatalog::new(vec![row]);
        assert_eq!(page.models()[0].efforts.len(), 1);
    }
}
