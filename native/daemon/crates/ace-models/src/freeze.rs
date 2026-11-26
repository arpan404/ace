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
    //! `freeze.ts` has no TypeScript test file. These guard the boundary it exists for:
    //! a picker that keeps a row or a page sees the same models after the catalog is
    //! refreshed, because a refresh swaps a pointer rather than rewriting the shared
    //! value. They fail if the boundary hands out empty or re-created rows.

    use super::*;
    use ace_protocol::generated::ProviderKind;
    use serde_json::json;

    fn model(id: &str) -> CatalogModel {
        let instance =
            crate::instance::ModelInstance::cli("account", ProviderKind::Codex, "", "/repo");
        crate::row::base(&instance, id, id, &json!({ "status": "active" }))
    }

    #[test]
    fn a_row_kept_from_a_replaced_catalog_stays_the_same_row() {
        let catalog = FrozenCatalog::new(vec![model("a")]);
        let Some(kept) = catalog.model(0) else {
            panic!("the catalog has a first row");
        };
        let replaced = FrozenCatalog::new(vec![model("b")]);
        assert_eq!(kept.id.0, "a");
        assert_eq!(kept.display_name.0, "A");
        assert_eq!(replaced.models()[0].id.0, "b");
    }

    #[test]
    fn a_shared_page_is_not_rewritten_when_a_new_catalog_replaces_it() {
        let first = FrozenCatalog::new(vec![model("a"), model("b")]);
        let page = first.shared();
        let next = FrozenCatalog::new(vec![model("c")]);
        assert_eq!(page.len(), 2);
        assert_eq!(page[1].id.0, "b");
        assert_eq!(next.models()[0].id.0, "c");
        assert_eq!(first.len(), 2);
    }

    #[test]
    fn frozen_rows_own_their_nested_collections() {
        use crate::effort::model_efforts;
        let mut row = model("m");
        row.efforts = model_efforts([
            crate::effort::EffortValue::id("low"),
            crate::effort::EffortValue::id("high"),
        ])
        .into();
        let catalog = FrozenCatalog::new(vec![row]);
        let frozen = &catalog.models()[0];
        assert_eq!(frozen.efforts.len(), 2);
        assert_eq!(frozen.efforts[0].label.0, "Low");
        assert_eq!(
            frozen.efforts[1].level,
            Some(ace_protocol::generated::EffortLevel::High)
        );
        assert!(frozen.raw.json.contains("active"));
    }

    #[test]
    fn an_empty_or_out_of_range_page_hands_out_nothing() {
        let empty = FrozenCatalog::new(Vec::new());
        assert!(empty.is_empty());
        assert!(empty.model(0).is_none());
        let one = FrozenCatalog::new(vec![model("only")]);
        assert!(one.model(1).is_none());
        assert_eq!(
            one.model(0).map(|row| row.id.0.clone()),
            Some("only".to_owned())
        );
    }
}
