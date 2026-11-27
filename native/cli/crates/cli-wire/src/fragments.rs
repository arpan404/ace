// SPDX-License-Identifier: Apache-2.0
//! Fragment reassembly for `entities.page.part` frames, matching `FragmentPolicy` and
//! `FragmentAssembly` in `packages/client/src/fragment-policy.ts` and `fragment-assembly.ts`.

use std::borrow::Cow;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::error::WireError;

/// Aggregate retained UTF-16 byte budget across in-flight fragment assemblies (64 MiB).
pub const MAX_FRAGMENT_BYTES: usize = 64 * 1024 * 1024;

/// Maximum concurrent in-flight fragment sources (matching `FragmentPolicy`).
const MAX_FRAGMENT_SOURCES: usize = 4;

/// Maximum UTF-16 code units per single fragment part (`wire-core.ts`: `z.string().max(131072)`).
const MAX_FRAGMENT_PART_CHARS: usize = 131_072;

/// Absolute lifetime from a fragment sequence's first part (30 s, matching `defaultLimits.fragmentMs`).
pub const FRAGMENT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntitiesPagePart<'a> {
    #[serde(borrow)]
    request_id: Cow<'a, str>,
    #[serde(borrow)]
    thread_id: Cow<'a, str>,
    seq: u64,
    index: u64,
    done: bool,
    #[serde(borrow)]
    data: Cow<'a, str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteEntitiesPageCheck<'a> {
    #[serde(rename = "type", borrow)]
    msg_type: Cow<'a, str>,
    #[serde(borrow)]
    request_id: Cow<'a, str>,
    page: CompletePageHeader<'a>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompletePageHeader<'a> {
    #[serde(borrow)]
    thread_id: Cow<'a, str>,
    seq: u64,
}

struct Entry {
    thread_id: String,
    seq: u64,
    next_index: u64,
    utf16_bytes: usize,
    deadline: Instant,
    data: String,
}

/// Reassembles fragmented `entities.page.part` messages with bounded UTF-16 byte budget,
/// source count, sequence checking, and per-assembly absolute deadline.
#[derive(Default)]
pub(crate) struct FragmentAssembler {
    entries: HashMap<String, Entry>,
    total_bytes: usize,
}

impl FragmentAssembler {
    /// Returns the earliest deadline among active partial assemblies, if any.
    pub(crate) fn earliest_deadline(&self) -> Option<Instant> {
        self.entries.values().map(|e| e.deadline).min()
    }

    /// Fails with [`WireError::Offline`] (matching `#lost(4009, "Fragments timed out")`) if any
    /// partial assembly has exceeded its 30 s absolute lifetime.
    pub(crate) fn check_expired(&mut self, now: Instant) -> Result<(), WireError> {
        if self.entries.values().any(|e| now >= e.deadline) {
            self.clear();
            return Err(WireError::Offline {
                detail: "Fragments timed out".into(),
            });
        }
        Ok(())
    }

    /// Feeds one `entities.page.part` JSON frame. Returns `Ok(Some(complete_json))` once the
    /// final (`done: true`) part arrives and passes `matchesFragments`, or `Ok(None)` while more
    /// parts are pending.
    pub(crate) fn add_entities_page_part(
        &mut self,
        raw_part_json: &str,
        now: Instant,
    ) -> Result<Option<String>, WireError> {
        self.check_expired(now)?;
        let part: EntitiesPagePart<'_> =
            serde_json::from_str(raw_part_json).map_err(|err| WireError::Protocol {
                detail: format!("Malformed entities.page.part frame: {err}"),
            })?;
        if part.request_id.is_empty() || part.thread_id.is_empty() {
            return Err(WireError::Protocol {
                detail: "entities.page.part missing requestId or threadId".into(),
            });
        }

        let utf16_units = part.data.encode_utf16().count();
        if utf16_units > MAX_FRAGMENT_PART_CHARS {
            return Err(WireError::Limit {
                detail: "Fragment part exceeded size limit".into(),
            });
        }
        let part_bytes = utf16_units.saturating_mul(2);
        let key = part.request_id.as_ref();

        if part.index == 0 {
            if self.entries.contains_key(key) {
                return Err(WireError::Protocol {
                    detail: "Repeated fragment start".into(),
                });
            }
            if self.entries.len() >= MAX_FRAGMENT_SOURCES {
                return Err(WireError::Limit {
                    detail: "Fragment source budget exceeded".into(),
                });
            }
            if self.total_bytes.saturating_add(part_bytes) > MAX_FRAGMENT_BYTES {
                return Err(WireError::Limit {
                    detail: "Fragment byte budget exceeded".into(),
                });
            }
            let mut data = String::with_capacity(part.data.len());
            data.push_str(&part.data);
            if part.done {
                verify_complete_page(&data, key, part.thread_id.as_ref(), part.seq)?;
                return Ok(Some(data));
            }
            self.total_bytes += part_bytes;
            self.entries.insert(
                key.to_owned(),
                Entry {
                    thread_id: part.thread_id.into_owned(),
                    seq: part.seq,
                    next_index: 1,
                    utf16_bytes: part_bytes,
                    deadline: now + FRAGMENT_TIMEOUT,
                    data,
                },
            );
            return Ok(None);
        }

        let valid = self.entries.get(key).is_some_and(|entry| {
            entry.seq == part.seq
                && entry.next_index == part.index
                && entry.thread_id == part.thread_id.as_ref()
        });
        if !valid {
            return Err(WireError::Protocol {
                detail: "Fragment out of sequence".into(),
            });
        }
        if self.total_bytes.saturating_add(part_bytes) > MAX_FRAGMENT_BYTES {
            return Err(WireError::Limit {
                detail: "Fragment byte budget exceeded".into(),
            });
        }

        if part.done {
            let Some(mut entry) = self.entries.remove(key) else {
                return Err(WireError::Protocol {
                    detail: "Fragment out of sequence".into(),
                });
            };
            self.total_bytes = self.total_bytes.saturating_sub(entry.utf16_bytes);
            entry.data.push_str(&part.data);
            verify_complete_page(&entry.data, key, &entry.thread_id, entry.seq)?;
            return Ok(Some(entry.data));
        }

        if let Some(entry) = self.entries.get_mut(key) {
            entry.next_index += 1;
            entry.utf16_bytes += part_bytes;
            self.total_bytes += part_bytes;
            entry.data.push_str(&part.data);
        }
        Ok(None)
    }

    /// Drops all in-flight partial assemblies.
    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.total_bytes = 0;
    }
}

/// Checks `matchesFragments` from `packages/client/src/fragment-assembly.ts`:
/// `type == "entities.page"`, `requestId == part.requestId`, `page.threadId == part.threadId`,
/// and `page.seq == part.seq`.
fn verify_complete_page(
    complete_json: &str,
    expected_request_id: &str,
    expected_thread_id: &str,
    expected_seq: u64,
) -> Result<(), WireError> {
    let header: CompleteEntitiesPageCheck<'_> =
        serde_json::from_str(complete_json).map_err(|err| WireError::Protocol {
            detail: format!("Malformed reassembled entities.page: {err}"),
        })?;
    if header.msg_type != "entities.page"
        || header.request_id != expected_request_id
        || header.page.thread_id != expected_thread_id
        || header.page.seq != expected_seq
    {
        return Err(WireError::Protocol {
            detail: "Fragments don't match their message".into(),
        });
    }
    Ok(())
}
