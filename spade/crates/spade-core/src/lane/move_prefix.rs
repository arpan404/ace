//! Moving main's open reply to a task lane while keeping main's prompt prefix byte for byte
//! (ADR 0217 §2a, amended for prompt-cache sharing).
//!
//! Instead of summarising main's chat into a quoted block ahead of the reply, a moved lane starts
//! from main's prompt content since its last compaction in main's exact order, maps copied indices
//! back to main's sequence numbers (`CopiedSpan`), and appends its task framing (`lane_moved`),
//! kept-job notes and sliced asks ledger (`asks_noted`) at the tail.

use std::collections::HashSet;

use crate::asks::Ledger;
use crate::asks::steer::{Steering, Watched};
use crate::event::{Event, Known};

use super::{CopiedSpan, KEPT_JOB, Link, MovedIn, asked_for_lane, is_reply_end, title_of};

/// Inputs from main at the moment Spade moves main's open reply to a lane.
pub struct MoveContext<'a> {
    pub main: &'a str,
    pub call: &'a str,
    pub reply: &'a str,
    pub moved_jobs: &'a [String],
    /// `(job_id, tool_name)` for jobs of `reply` that stay with main.
    pub kept_jobs: &'a [(String, String)],
    pub moved_wakes: &'a [String],
    pub untrusted: bool,
}

/// Complete initial events and metadata for a lane made by moving main's open reply.
pub struct MovedLane {
    /// Initial events for the lane: `lane_of`, optional pre-compaction preamble, copied prompt
    /// events from main, `lane_moved`, kept-job `job_finished` notes, and sliced `asks_noted`.
    pub events: Vec<Event>,
    /// The lane's initial title (first line of the moved ask).
    pub title: String,
    /// The person's verbatim words that opened the moved reply (fed to the `title` role).
    pub words: String,
    /// Main's asks-ledger ids handed over to the lane.
    pub asks: Vec<String>,
}

/// Builds the moved lane's initial events from main's `events` and open `ctx.reply`.
/// Returns `None` if `ctx.reply` has no `reply_started` in `events`.
pub fn build_moved(events: &[Event], ctx: MoveContext<'_>) -> Option<MovedLane> {
    let start = events.iter().position(
        |e| matches!(e, Event::Known(Known::ReplyStarted { reply: r, .. }) if r == ctx.reply),
    )?;
    let previous_end = events[..start]
        .iter()
        .rposition(is_reply_end)
        .map_or(0, |at| at + 1);
    let maker = crate::asks::maker_of(events);
    let main_ledger = Ledger::of(events);

    let mut word_parts = Vec::new();
    for event in &events[previous_end..start] {
        if crate::asks::is_persons(event, maker)
            && let Event::Known(Known::UserMessage { text, .. }) = event
        {
            word_parts.push(text.trim().to_owned());
        }
    }
    let words = word_parts.join("\n\n");
    let title = title_of(&words);
    let asks = collect_asks(events, previous_end, maker, &main_ledger);

    let compaction = events.iter().enumerate().rev().find_map(|(at, e)| match e {
        Event::Known(Known::ContextCompacted { keep_from, .. }) => {
            Some((at, (*keep_from).min(events.len())))
        }
        _ => None,
    });
    let comp_at = compaction.map(|(at, _)| at);
    let main_from = compaction.map_or(0, |(_, keep_from)| keep_from);

    let mut first = Vec::with_capacity(events.len().saturating_sub(main_from) + 8);
    first.push(Event::Known(Known::LaneOf(Link {
        parent_conversation: ctx.main.to_owned(),
        call: ctx.call.to_owned(),
        title: title.clone(),
        asks: asks.clone(),
        untrusted: ctx.untrusted,
        moved_from: Some(ctx.reply.to_owned()),
        copied: Vec::new(),
    })));

    if main_from > 0 {
        push_preamble(&mut first, events, main_from, comp_at);
    }
    let lane_from = first.len();

    let open_questions: HashSet<String> = crate::question::views(events)
        .into_iter()
        .filter(|v| {
            matches!(
                v.standing,
                crate::question::Standing::Deferred | crate::question::Standing::Waiting
            )
        })
        .map(|v| v.call_id)
        .collect();
    let keep_prior_goal = crate::goal::view::pinned(events).is_some()
        || crate::goal::Task::fold(&events[..start]).is_some_and(|t| t.goal.closed.is_none());

    let kept_orig: Vec<usize> = (main_from..events.len())
        .filter(|&orig| keep_in_span(events, orig, start, &ctx, &open_questions, keep_prior_goal))
        .collect();
    let map_index = |orig_target: usize| -> usize {
        if orig_target <= main_from {
            lane_from
        } else {
            lane_from + kept_orig.partition_point(|&orig| orig < orig_target)
        }
    };

    let mut copied: Vec<CopiedSpan> = Vec::new();
    let mut prev_orig: Option<usize> = None;
    for &orig in &kept_orig {
        let lane_at = first.len();
        if prev_orig.is_some_and(|prev| orig == prev + 1)
            && let Some(last) = copied.last_mut()
        {
            last.len += 1;
        } else {
            copied.push(CopiedSpan {
                at: lane_at,
                len: 1,
                main_seq: orig as u64 + 1,
            });
        }
        prev_orig = Some(orig);

        let mut cloned = events[orig].clone();
        remap_copied(&mut cloned, orig, start, main_from, ctx.reply, &map_index);
        first.push(cloned);
    }

    if let Some(Event::Known(Known::LaneOf(link))) = first.first_mut() {
        link.copied = copied;
    }

    first.push(Event::Known(Known::LaneMoved(MovedIn {
        title: title.clone(),
        asks: asks.clone(),
        untrusted: ctx.untrusted,
    })));
    for (job, name) in ctx.kept_jobs {
        first.push(Event::Known(Known::JobFinished {
            job: job.clone(),
            name: name.clone(),
            content: KEPT_JOB.to_owned(),
            is_error: false,
            uncertain: false,
            files: Vec::new(),
            untrusted: false,
            cost_micros: None,
        }));
    }

    let through = first.len() + 1;
    let lane_ledger = slice_ledger(
        &main_ledger,
        &asks,
        ctx.reply,
        main_from,
        through,
        &map_index,
    );
    first.push(Event::Known(Known::AsksNoted(Box::new(lane_ledger))));

    Some(MovedLane {
        events: first,
        title,
        words,
        asks,
    })
}

/// Asks from `previous_end..` that still live in main's ledger (including split parts and
/// unrouted mid-turn steers on the moving reply, excluding anything already handed to another
/// lane).
fn collect_asks(
    events: &[Event],
    previous_end: usize,
    maker: Option<&str>,
    main_ledger: &Ledger,
) -> Vec<String> {
    let mut asks = Vec::new();
    for (at, event) in events.iter().enumerate().skip(previous_end) {
        if !crate::asks::is_persons(event, maker) {
            continue;
        }
        if !matches!(event, Event::Known(Known::UserMessage { .. })) {
            continue;
        }
        let id = crate::chat_markup::id(at as u64 + 1, 0);
        if main_ledger.ask(&id).is_some() {
            if !asks.contains(&id) {
                asks.push(id);
            }
        } else {
            let prefix = format!("{id}.");
            for ask in &main_ledger.asks {
                if ask.id.starts_with(&prefix) && !asks.contains(&ask.id) {
                    asks.push(ask.id.clone());
                }
            }
        }
    }
    asks
}

/// Minimal events from `events[..main_from]` placed before the compaction cut in the lane so
/// `context::instructions` (task, personality, naming note, indexes, pinned goal), late question
/// answers, card actions and mid-turn steer detection match main byte for byte.
fn push_preamble(
    first: &mut Vec<Event>,
    events: &[Event],
    main_from: usize,
    comp_at: Option<usize>,
) {
    let before = &events[..main_from];

    // Effective AgentConfigured (preserving the latest explicit task change for `by_bot`).
    if let Some(configured) = before
        .iter()
        .rev()
        .find(|e| matches!(e, Event::Known(Known::AgentConfigured { .. })))
        .cloned()
    {
        let mut configured = configured;
        if let Event::Known(Known::AgentConfigured { change, .. }) = &mut configured
            && change.is_none()
        {
            *change = before.iter().rev().find_map(|e| match e {
                Event::Known(Known::AgentConfigured {
                    change: Some(c), ..
                }) => Some(c.clone()),
                _ => None,
            });
        }
        first.push(configured);
    }

    if crate::self_edit::naming_open(before) {
        first.push(Event::Known(Known::NamingOpened {}));
    }

    for pred in [
        (|e: &Event| matches!(e, Event::Known(Known::SkillsIndexed { .. }))) as fn(&Event) -> bool,
        |e| matches!(e, Event::Known(Known::PluginsStarted { .. })),
        |e| matches!(e, Event::Known(Known::MemoryIndexed { .. })),
        |e| matches!(e, Event::Known(Known::KnowledgeIndexed { .. })),
    ] {
        if let Some(found) = before.iter().rev().find(|e| pred(e)) {
            first.push(found.clone());
        }
    }

    // Pre-compaction goal events needed by `goal::view::pinned`.
    if let Some(comp_at) = comp_at
        && crate::goal::view::pinned(events).is_some()
        && !events[main_from..comp_at]
            .iter()
            .any(|e| matches!(e, Event::Known(Known::GoalSet { .. })))
        && let Some(goal_at) = before
            .iter()
            .rposition(|e| matches!(e, Event::Known(Known::GoalSet { .. })))
    {
        for event in &before[goal_at..] {
            if is_goal_event(event) {
                first.push(event.clone());
            }
        }
    }

    // Questions from `before` referenced by a late answer/dismissal in `events[main_from..]`.
    let mut late_calls: Vec<&str> = Vec::new();
    for event in &events[main_from..] {
        if let Event::Known(
            Known::QuestionAnswered {
                call_id,
                late: true,
                ..
            }
            | Known::QuestionDismissed {
                call_id,
                late: true,
            },
        ) = event
            && !asked_for_lane(events, call_id)
            && !late_calls.contains(&call_id.as_str())
        {
            late_calls.push(call_id.as_str());
        }
    }
    for call_id in late_calls {
        let in_kept = events[main_from..].iter().any(
            |e| matches!(e, Event::Known(Known::QuestionAsked { call_id: c, .. }) if c == call_id),
        );
        if !in_kept
            && let Some(asked) = before.iter().rev().find(|e| {
                matches!(e, Event::Known(Known::QuestionAsked { call_id: c, .. }) if c == call_id)
            })
        {
            first.push(asked.clone());
        }
    }

    // Cards from `before` referenced by a `CardAction` in `events[main_from..]`.
    let mut card_ids: Vec<&str> = Vec::new();
    for event in &events[main_from..] {
        if let Event::Known(Known::CardAction { card, .. }) = event
            && !card_ids.contains(&card.as_str())
        {
            card_ids.push(card.as_str());
        }
    }
    for card_id in card_ids {
        let in_kept = events[main_from..]
            .iter()
            .any(|e| matches!(e, Event::Known(Known::CardShown(shown)) if shown.card == card_id));
        if !in_kept
            && let Some(shown) = before.iter().rev().find(
                |e| matches!(e, Event::Known(Known::CardShown(shown)) if shown.card == card_id),
            )
        {
            first.push(shown.clone());
        }
    }

    // Mid-turn compaction: if a reply was open across `main_from`, keep its `ReplyStarted` after
    // `AgentConfigured` and `NamingOpened` so `configured_for_turn`, `naming_note`, `turn_model`
    // and `asks::steer::mid_turn` all match main.
    let open_before = before
        .iter()
        .rev()
        .find(|e| matches!(e, Event::Known(Known::ReplyStarted { .. })) || is_reply_end(e));
    if let Some(reply_started) = open_before
        && matches!(reply_started, Event::Known(Known::ReplyStarted { .. }))
    {
        first.push(reply_started.clone());
    }
}

/// Whether `events[orig]` (with `orig >= main_from`) belongs in the moved lane's copied prefix:
/// keeps every event read by the prompt builder, turn loop or goal/steer state, and drops main's
/// unrelated operational events (other lanes, services, contracts, approvals, non-moving jobs and
/// wakes, open deferred questions, and old ledger snapshots).
fn keep_in_span(
    events: &[Event],
    orig: usize,
    start: usize,
    ctx: &MoveContext<'_>,
    open_questions: &HashSet<String>,
    keep_prior_goal: bool,
) -> bool {
    let Event::Known(known) = &events[orig] else {
        return false;
    };
    if is_goal_event(&events[orig]) {
        return orig >= start || keep_prior_goal;
    }
    match known {
        Known::JobStarted { job, .. } => {
            ctx.moved_jobs.contains(job) || ctx.kept_jobs.iter().any(|(j, _)| j == job)
        }
        Known::WakeSet { wake, .. } | Known::WakeCancelled { wake, .. } => {
            ctx.moved_wakes.contains(wake)
        }
        Known::ApprovalRequested { .. } | Known::ApprovalAnswered { .. } => false,
        Known::QuestionAsked { call_id, lane, .. } => {
            lane.is_none() && !open_questions.contains(call_id.as_str())
        }
        Known::QuestionDeferred { call_id, .. } => {
            !asked_for_lane(events, call_id) && !open_questions.contains(call_id.as_str())
        }
        Known::QuestionAnswered { call_id, .. } | Known::QuestionDismissed { call_id, .. } => {
            !asked_for_lane(events, call_id)
        }
        Known::StepServed(served) => served.reply == ctx.reply,
        Known::WorkerStarted(_)
        | Known::WorkerDetached { .. }
        | Known::ServiceStarted { .. }
        | Known::ServiceEnded { .. }
        | Known::ContractCalled(_)
        | Known::ContractEnded { .. }
        | Known::ContractMisfit { .. }
        | Known::LaneStarted(_)
        | Known::LaneTitled(_)
        | Known::LaneMessaged(_)
        | Known::LaneRequestsClosed(_)
        | Known::PluginOutsideAsked { .. }
        | Known::PluginOutsideAnswered { .. }
        | Known::AsksNoted(_)
        | Known::AsksUpdated(_)
        | Known::Renamed { .. }
        | Known::StopRequested { .. }
        | Known::TurnPaused { .. }
        | Known::TurnParked { .. }
        | Known::TaskPaused { .. }
        | Known::TaskParked { .. } => false,
        _ => true,
    }
}

fn remap_copied(
    event: &mut Event,
    orig: usize,
    start: usize,
    main_from: usize,
    moving_reply: &str,
    map_index: &impl Fn(usize) -> usize,
) {
    let Event::Known(known) = event else { return };
    match known {
        Known::ContextCompacted {
            keep_from, asks, ..
        } => {
            *keep_from = map_index(*keep_from);
            *asks = None;
        }
        Known::ResultsAged { before } => {
            *before = map_index(*before);
        }
        Known::StepFinished {
            reply,
            seen,
            cost_micros,
            ..
        } => {
            *seen = seen.map(map_index);
            if reply != moving_reply {
                *cost_micros = 0;
            }
        }
        Known::JobFinished { cost_micros, .. } if orig < start => {
            *cost_micros = None;
        }
        Known::HookRan { hook, target, .. }
            if hook == crate::hooks::USER_PROMPT_SUBMIT || hook == crate::hooks::STOP =>
        {
            if let Ok(orig_idx) = target.parse::<usize>()
                && orig_idx >= main_from
            {
                *target = map_index(orig_idx).to_string();
            }
        }
        _ => {}
    }
}

fn slice_ledger(
    main: &Ledger,
    moved_asks: &[String],
    reply: &str,
    main_from: usize,
    through: usize,
    map_index: &impl Fn(usize) -> usize,
) -> Ledger {
    let owns = |id: &str| {
        moved_asks.iter().any(|m| {
            id == m
                || id
                    .strip_prefix(m.as_str())
                    .is_some_and(|rest| rest.starts_with('.'))
        })
    };
    let asks = main.asks.iter().filter(|a| owns(&a.id)).cloned().collect();
    let watched = main
        .watched
        .iter()
        .filter(|w| owns(&w.id) && w.at >= main_from)
        .map(|w| Watched {
            at: map_index(w.at),
            ..w.clone()
        })
        .collect();
    Ledger {
        through,
        asks,
        standing: main.standing.clone(),
        earlier: 0,
        standing_made: main.standing_made,
        steering: Steering {
            running: Some(reply.to_owned()),
            asking: false,
        },
        watched,
        checked: (main.checked.as_deref() == Some(reply)).then(|| reply.to_owned()),
        cards: Default::default(),
        stored: through,
    }
}

fn is_goal_event(event: &Event) -> bool {
    matches!(
        event,
        Event::Known(
            Known::GoalSet { .. }
                | Known::GoalCleared { .. }
                | Known::PlanChanged { .. }
                | Known::PlanCheckpoint { .. }
                | Known::TaskVerified { .. }
        )
    )
}
