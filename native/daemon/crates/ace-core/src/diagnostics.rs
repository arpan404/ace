// SPDX-License-Identifier: Apache-2.0
//! The rejection notices of `diagnostics.ts`: invalid facts become warning
//! items carrying the verbatim fact, and the fold goes on. Rejection never
//! creates agents or refreshes liveness.

use crate::emit::{Event, emit, get, put};
use crate::item_model::RawPayload;
use crate::items::Item;
use crate::json_io::{Json, diagnostic_data};
use crate::state::{ApplyContext, ThreadState};

/// A repeated rejection keeps the raw facts of its first occurrences.
const REPEAT_RAW_LIMIT: usize = 10;

/// Publish one deferred or immediate warning notice for `owner`.
fn publish_notice(
    state: &mut ThreadState,
    owner_key: &str,
    text: String,
    raw: Vec<RawPayload>,
    created_at: i64,
    run_id: Option<String>,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<String> {
    let id = ctx.ids.next("item")?;
    let agent_id = get(&state.agents, owner_key)?.agent.id.clone();
    let item = Item::Notice {
        base: crate::items::ItemBase {
            id: id.clone(),
            agent_id,
            run_id,
            created_at,
            native_id: None,
            execution_source: None,
            complete: true,
            inherited: None,
            raw_omitted: None,
        },
        level: "warning".to_owned(),
        command_id: None,
        interaction_id: None,
        code: None,
        diagnostic: None,
        title: None,
        detail: None,
        details: None,
        tool_call_id: None,
        measurement: None,
        asked: None,
        text,
        source: None,
        raw,
    };
    let mut key = format!("ace:notice:{id}");
    while state.items.contains_key(&key) {
        key.push(':');
    }
    let stored = key.clone();
    put(&mut state.items, key, item.clone());
    emit(events, Event::ItemCreated { item });
    Some(stored)
}

/// Reject one invalid fact as a warning notice.
pub fn reject_fact(
    state: &mut ThreadState,
    input: &Json,
    reason: &str,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<()> {
    let text = format!("Ignored adapter fact: {reason}");
    let raw = RawPayload::Inline {
        payload_type: "core.rejected_fact".to_owned(),
        name: None,
        data: crate::item_model::vet_json(&diagnostic_data(input)).ok()?.0,
    };
    let owner_key = state.root_key.clone();
    let Some(owner_key) = owner_key else {
        state.pending_notices.push(crate::state::PendingNotice {
            created_at: ctx.now,
            text,
            raw: vec![raw],
        });
        return Some(());
    };
    // An adapter that keeps re-sending a fact core cannot accept must not
    // flood the transcript.
    let run = get(&state.agents, &owner_key)
        .and_then(|record| record.active_run.clone())
        .unwrap_or_default();
    let same_run = state
        .rejection_notices
        .as_ref()
        .is_some_and(|notices| notices.run == run);
    if !same_run {
        state.rejection_notices = Some(crate::state::RejectionNotices {
            run: run.clone(),
            notices: indexmap::IndexMap::new(),
        });
    }
    let fact_type = match input.get("type").and_then(|kind| kind.as_str()) {
        Some(kind) => kind.to_owned(),
        None => String::new(),
    };
    let signature = format!("{fact_type}\0{reason}");
    let repeated = state
        .rejection_notices
        .as_ref()
        .and_then(|notices| notices.notices.get(&signature))
        .map(|notice| (notice.item.clone(), notice.count));
    if let Some((item_key, count)) = repeated {
        let update = match get(&state.items, &item_key) {
            Some(Item::Notice { .. }) => true,
            _ => false,
        };
        if update {
            if let Some(notices) = state.rejection_notices.as_mut() {
                if let Some(notice) = notices.notices.get_mut(&signature) {
                    notice.count = count + 1;
                }
            }
            if let Some(Item::Notice {
                base: _,
                text: item_text,
                raw: item_raw,
                ..
            }) = state.items.get_mut(&item_key)
            {
                *item_text = format!("{text} ({} times)", count + 1);
                if item_raw.len() < REPEAT_RAW_LIMIT {
                    item_raw.push(raw);
                }
            }
            if let Some(item) = get(&state.items, &item_key) {
                emit(events, Event::ItemUpdated { item: item.clone() });
            }
            return Some(());
        }
    }
    let run_id = get(&state.agents, &owner_key).and_then(|record| record.active_run.clone());
    let key = publish_notice(
        state,
        &owner_key,
        text,
        vec![raw],
        ctx.now,
        run_id,
        ctx,
        events,
    )?;
    if let Some(notices) = state.rejection_notices.as_mut() {
        put(
            &mut notices.notices,
            signature,
            crate::state::RejectionNotice {
                item: key,
                count: 1,
            },
        );
    }
    Some(())
}

/// Deferred warnings join the first root established by valid provider facts.
pub fn flush_notices(
    state: &mut ThreadState,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<()> {
    if state.pending_notices.is_empty() {
        return Some(());
    }
    // Before the root exists notices wait; losing them would drop the
    // rejection the tick is meant to carry once the root arrives.
    let Some(owner_key) = state.root_key.clone() else {
        return Some(());
    };
    let notices = std::mem::take(&mut state.pending_notices);
    for notice in notices {
        publish_notice(
            state,
            &owner_key,
            notice.text,
            notice.raw,
            notice.created_at,
            None,
            ctx,
            events,
        )?;
    }
    Some(())
}
