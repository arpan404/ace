// SPDX-License-Identifier: Apache-2.0
//! The binding for `ace_store::reads::items`. Phase 1b: item pages, windows and tails (docs/store/porting-guide.md).

use super::NativeDatabase;
use ace_store::reads::items::{self, Trust, WindowQuery};
use napi_derive::napi;

/// The store's trust floor and rejected sequences, as the shell passes them.
#[napi(object)]
pub struct TrustArgs {
    pub trust_from: Option<f64>,
    pub rejected: Vec<f64>,
}

/// One kept tail entry: its id and creation sequence.
#[napi(object)]
pub struct KeptItem {
    pub id: String,
    pub seq: f64,
}

/// An items-window request: navigation, budget, trust and the shell-rejected sequences.
#[napi(object)]
pub struct WindowArgs {
    pub thread_id: String,
    pub around_seq: f64,
    pub before: f64,
    pub after: f64,
    pub byte_limit: f64,
    pub trust: TrustArgs,
    pub drop: Vec<f64>,
}

/// The shell reports errors by variant: capacity as the loader's own error, a gone body as the
/// loader's own `JSON.parse`, anything else as it came out.
fn fail(error: items::ReadError) -> napi::Error {
    match error {
        items::ReadError::Capacity => {
            napi::Error::from_reason("ItemPageCapacityExceeded: Item detail exceeds page capacity")
        }
        items::ReadError::UndefinedJson => napi::Error::from_reason("AceItemsUndefinedJson"),
        other => napi::Error::from_reason(other.to_string()),
    }
}

fn trust_of(args: TrustArgs) -> (Option<i64>, std::collections::HashSet<i64>) {
    (
        args.trust_from.map(|from| from as i64),
        args.rejected.iter().map(|seq| *seq as i64).collect(),
    )
}

#[napi]
impl NativeDatabase {
    /// `ItemStore.wirePage`: the newest items before `before` that fit `byteLimit`, oldest first.
    #[napi(catch_unwind)]
    pub fn items_wire_page(
        &self,
        thread_id: String,
        before: f64,
        limit: f64,
        byte_limit: f64,
        trust: TrustArgs,
    ) -> napi::Result<String> {
        let (from, rejected) = trust_of(trust);
        items::wire_page(
            self.connection(),
            &thread_id,
            before,
            limit,
            byte_limit,
            Trust {
                from,
                rejected: &rejected,
            },
        )
        .map_err(fail)
    }

    /// `ItemStore.page`: whole items, oldest first, with the byte budget by stored sizes.
    #[napi(catch_unwind)]
    pub fn items_page(
        &self,
        thread_id: String,
        before: f64,
        limit: f64,
        byte_limit: Option<f64>,
        trust: TrustArgs,
    ) -> napi::Result<String> {
        let (from, rejected) = trust_of(trust);
        items::page(
            self.connection(),
            &thread_id,
            before,
            limit,
            byte_limit,
            Trust {
                from,
                rejected: &rejected,
            },
        )
        .map_err(fail)
    }

    /// `ItemStore.window`: the jump point and its neighbors that fit. `drop` holds the
    /// creation sequences whose reduced item the shell already rejected: shown as summarized.
    #[napi(catch_unwind)]
    pub fn items_window(&self, query: WindowArgs) -> napi::Result<String> {
        let (from, rejected) = trust_of(query.trust);
        let dropped: Vec<i64> = query.drop.iter().map(|seq| *seq as i64).collect();
        items::window(
            self.connection(),
            &query.thread_id,
            WindowQuery {
                around_seq: query.around_seq,
                before: query.before,
                after: query.after,
                byte_limit: query.byte_limit,
                trust: Trust {
                    from,
                    rejected: &rejected,
                },
                dropped: &dropped,
            },
        )
        .map_err(fail)
    }

    /// `ItemStore.tail` from rows the shell read on the store's connection: the kept items.
    #[napi(catch_unwind)]
    pub fn items_tail_rows(
        &self,
        thread_id: String,
        kept: Vec<KeptItem>,
        before: Option<f64>,
        preview: bool,
        rows: String,
        trust: TrustArgs,
    ) -> napi::Result<String> {
        let (from, rejected) = trust_of(trust);
        let kept: Vec<(String, i64)> = kept
            .into_iter()
            .map(|item| (item.id, item.seq as i64))
            .collect();
        items::tail_rows(
            self.connection(),
            &thread_id,
            &kept,
            before.map(|before| before as i64),
            preview,
            &rows,
            Trust {
                from,
                rejected: &rejected,
            },
        )
        .map_err(fail)
    }
}
