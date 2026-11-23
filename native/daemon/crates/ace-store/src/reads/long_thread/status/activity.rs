// SPDX-License-Identifier: Apache-2.0
//! Turn activity from live counters and the page's child statuses.
//!
//! Historical turns combine their own live activity, not a later root turn's status.

use super::super::turns_types::Counters;
use super::thread::Status;

pub fn status_state(status: &Status) -> &str {
    match status {
        Status::NeedsYou { .. } => "needs_you",
        Status::Working { .. } => "working",
        Status::Waiting { .. } => "waiting",
        Status::Limited { .. } => "limited",
        Status::Failed => "failed",
        Status::Unresponsive => "unresponsive",
        Status::Moved { .. } => "moved",
        Status::Done => "done",
        Status::New => "new",
        Status::Unknown { .. } => "unknown",
    }
}

/// A newer daemon's state never reads as settled.
pub fn turn_is_settled(status: &Status) -> bool {
    !matches!(status, Status::Working { .. } | Status::Unknown { .. })
}

fn status_interactions(status: &Status) -> Option<i64> {
    match status {
        Status::NeedsYou { interactions } => Some(*interactions),
        _ => None,
    }
}

fn status_on(status: &Status) -> Option<&str> {
    match status {
        Status::Waiting { on, .. } => Some(on.as_str()),
        _ => None,
    }
}

/// Historical turns combine their own live activity, not a later root turn's status.
pub fn turn_activity_status(counters: &Counters, candidates: &[Status]) -> Option<Status> {
    let mut interactions = counters.get("live:interactions").unwrap_or(0);
    for candidate in candidates {
        if status_state(candidate) == "needs_you"
            && let Some(count) = status_interactions(candidate)
        {
            interactions = interactions.max(count);
        }
    }
    if interactions > 0 {
        return Some(Status::NeedsYou { interactions });
    }
    if candidates
        .iter()
        .any(|status| status_state(status) == "working")
    {
        let agents = counters.get("live:agents").unwrap_or(0).max(1);
        return Some(Status::Working { agents });
    }
    if let Some(limited) = candidates
        .iter()
        .find(|status| status_state(status) == "limited")
    {
        return Some(limited.clone());
    }
    for reason in ["network", "upstream"] {
        if candidates
            .iter()
            .any(|status| status_on(status) == Some(reason))
        {
            return Some(Status::Waiting {
                on: reason.to_owned(),
                slot_limit: None,
                slots_in_use: None,
                queue_position: None,
                waiting_for: None,
            });
        }
    }
    if counters.get("live:tasks").unwrap_or(0) > 0
        || counters.get("live:tools").unwrap_or(0) > 0
        || candidates
            .iter()
            .any(|status| status_on(status) == Some("background_task"))
    {
        return Some(Status::Waiting {
            on: "background_task".to_owned(),
            slot_limit: None,
            slots_in_use: None,
            queue_position: None,
            waiting_for: None,
        });
    }
    if candidates
        .iter()
        .any(|status| status_state(status) == "unresponsive")
    {
        return Some(Status::Unresponsive);
    }
    if let Some(waiting) = candidates
        .iter()
        .find(|status| status_state(status) == "waiting")
    {
        return Some(waiting.clone());
    }
    if counters.get("live:agents").unwrap_or(0) > 0 || counters.get("live:runs").unwrap_or(0) > 0 {
        let agents = counters.get("live:agents").unwrap_or(0).max(1);
        return Some(Status::Working { agents });
    }
    None
}
