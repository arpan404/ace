//! Batching pending `needs_you` notices from one bot or tree (ADR 0195). When several approvals
//! or questions from the same bot or orchestration tree arrive together, they reach the person as
//! one grouped notice instead of several. `block` and `stop` levels still reach the person as
//! ADR 0195 requires; `stop` is never batched here.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::escalation::{Level, one_line};
use crate::event::Event;
use crate::question::{Standing, standing};
use crate::transcript::Transcript;

use super::{Approvals, Category, Decision, Moment, Notice, Reach, Settings, decide};

/// How long pending `needs_you` asks from the same bot or tree wait to coalesce into one notice.
pub const WINDOW_MS: i64 = 250;

/// Which kind of `needs_you` event one item in a batch came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AskKind {
    Approval,
    Question,
}

impl AskKind {
    pub fn event_type(self) -> &'static str {
        match self {
            Self::Approval => "approval_requested",
            Self::Question => "question_asked",
        }
    }
}

/// The root bot of the tree whose pending asks are grouped together.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeRoot {
    pub agent: String,
    pub name: String,
    pub conversation: String,
}

/// One pending approval or question eligible to be grouped with others from its tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingAsk {
    pub id: String,
    pub agent: String,
    pub name: String,
    pub conversation: String,
    pub seq: i64,
    pub at_ms: i64,
    pub kind: AskKind,
    pub level: Level,
    pub request: String,
    pub text: String,
    pub engaged: bool,
    pub bot_on: bool,
    pub approvals: Approvals,
}

/// One notice produced from a tree's pending asks, ready to record and emit on `/notices/live`.
#[derive(Debug, Clone, PartialEq)]
pub struct Planned {
    pub id: String,
    pub agent: String,
    pub name: String,
    pub text: String,
    pub level: Level,
    pub decision: Decision,
    /// Source event ids (`PendingAsk::id`) represented by this notice.
    pub source_ids: Vec<String>,
    /// Notice JSON payload without `id`, `category`, `reach` or `why` (filled on send).
    pub notice: Value,
}

/// Whether `item` is still open in its conversation's stored `events`. Answered, dismissed,
/// deferred-while-blocking, or closed requests return `false` and must be dropped before flush.
pub fn still_open(events: &[Event], item: &PendingAsk) -> bool {
    match item.kind {
        AskKind::Approval => {
            let transcript = Transcript::fold(events);
            transcript.awaiting.contains(&item.request)
                || transcript
                    .helper_awaiting
                    .iter()
                    .any(|(id, _)| id == &item.request)
        }
        AskKind::Question => match item.level {
            Level::Block => standing(events, &item.request) == Some(Standing::Waiting),
            _ => matches!(
                standing(events, &item.request),
                Some(Standing::Waiting | Standing::Deferred)
            ),
        },
    }
}

/// Decides and groups `items` belonging to `root`'s tree at `moment`.
///
/// - Each item is decided against `settings` and `moment` using its own bot switches (`bot_on`,
///   `approvals`, `engaged`, `level`) so a silenced bot never leaks into a live alert and `block`
///   items still follow ADR 0195.
/// - One `now` (or `held`) item stays its exact individual `kind: "event"` notice.
/// - Two or more `now` (or `held`) items from the same bot or tree merge into one grouped
///   `kind: "needs_you_batch"` notice carrying the highest `level` in the group. When every item
///   belongs to one owning conversation (e.g. one worker), top-level fields deep-link there;
///   otherwise they link to `root` and `items` lists each item's conversation.
/// - A grouped `now` notice charges once against the proactive budget whenever any delivered item
///   is chargeable; when the budget is exhausted, urgent items (`block`, `engaged`) still deliver
///   while chargeable proactive items move to `held`.
pub fn plan(
    settings: &Settings,
    root: &TreeRoot,
    items: &[PendingAsk],
    moment: Moment<'_>,
) -> Vec<Planned> {
    if items.is_empty() {
        return Vec::new();
    }
    let mut now: Vec<(&PendingAsk, Decision)> = Vec::new();
    let mut held: Vec<(&PendingAsk, Decision)> = Vec::new();
    let mut none: Vec<(&PendingAsk, Decision)> = Vec::new();
    for item in items {
        let decision = decide(
            settings,
            Notice {
                category: Category::NeedsYou,
                level: Some(item.level),
                engaged: item.engaged,
                bot_on: item.bot_on,
                approvals: item.approvals,
            },
            moment,
        );
        match decision.reach {
            Reach::Now => now.push((item, decision)),
            Reach::Held => held.push((item, decision)),
            Reach::None => none.push((item, decision)),
        }
    }
    let mut out = Vec::new();
    push_bucket(&mut out, root, &now, Reach::Now);
    push_bucket(&mut out, root, &held, Reach::Held);
    for (item, decision) in none {
        out.push(single(item, decision));
    }
    out
}

fn push_bucket(
    out: &mut Vec<Planned>,
    root: &TreeRoot,
    bucket: &[(&PendingAsk, Decision)],
    reach: Reach,
) {
    match bucket {
        [] => {}
        [(item, decision)] => out.push(single(item, *decision)),
        many => {
            let items: Vec<&PendingAsk> = many.iter().map(|(item, _)| *item).collect();
            let decision = match reach {
                Reach::Now => Decision {
                    reach: Reach::Now,
                    why: None,
                    counts: many.iter().any(|(_, d)| d.counts),
                },
                Reach::Held => Decision {
                    reach: Reach::Held,
                    why: many[0].1.why,
                    counts: false,
                },
                Reach::None => return,
            };
            out.push(grouped(root, &items, decision));
        }
    }
}

fn single(item: &PendingAsk, decision: Decision) -> Planned {
    Planned {
        id: item.id.clone(),
        agent: item.agent.clone(),
        name: item.name.clone(),
        text: item.text.clone(),
        level: item.level,
        decision,
        source_ids: vec![item.id.clone()],
        notice: json!({
            "kind": "event",
            "agent": item.agent,
            "name": item.name,
            "conversation": item.conversation,
            "seq": item.seq,
            "at": item.at_ms,
            "type": item.kind.event_type(),
            "level": item.level,
            "request": item.request,
            "text": item.text,
        }),
    }
}

fn grouped(root: &TreeRoot, items: &[&PendingAsk], decision: Decision) -> Planned {
    let level = items.iter().map(|i| i.level).max().unwrap_or(Level::Ask);
    let approvals = items.iter().filter(|i| i.kind == AskKind::Approval).count();
    let questions = items.len().saturating_sub(approvals);
    let latest_at = items.iter().map(|i| i.at_ms).max().unwrap_or(0);
    let first_seq = items.first().map_or(0, |i| i.seq);
    // When every item in the batch belongs to one conversation (e.g. a single worker), deep-link
    // there directly; otherwise link to the tree root and list each item's target in `items`.
    let single_owner = items
        .first()
        .filter(|first| items.iter().all(|i| i.conversation == first.conversation));
    let (target_agent, target_name, target_conversation) = match single_owner {
        Some(owner) => (
            owner.agent.as_str(),
            owner.name.as_str(),
            owner.conversation.as_str(),
        ),
        None => (
            root.agent.as_str(),
            root.name.as_str(),
            root.conversation.as_str(),
        ),
    };
    let text = batch_text(target_agent, items);
    let id = batch_id(target_agent, latest_at, first_seq, items.len());
    let listed: Vec<Value> = items
        .iter()
        .map(|item| {
            json!({
                "id": item.id,
                "agent": item.agent,
                "name": item.name,
                "conversation": item.conversation,
                "seq": item.seq,
                "at": item.at_ms,
                "type": item.kind.event_type(),
                "request": item.request,
                "level": item.level,
                "text": item.text,
            })
        })
        .collect();
    Planned {
        id,
        agent: target_agent.to_owned(),
        name: target_name.to_owned(),
        text: text.clone(),
        level,
        decision,
        source_ids: items.iter().map(|i| i.id.clone()).collect(),
        notice: json!({
            "kind": "needs_you_batch",
            "agent": target_agent,
            "name": target_name,
            "conversation": target_conversation,
            "at": latest_at,
            "level": level,
            "count": items.len(),
            "approvals": approvals,
            "questions": questions,
            "text": text,
            "items": listed,
        }),
    }
}

/// One plain, lock-screen-safe line summarizing a batch of pending asks under `target_agent`.
pub fn batch_text(target_agent: &str, items: &[&PendingAsk]) -> String {
    let approvals = items.iter().filter(|i| i.kind == AskKind::Approval).count();
    let questions = items.len().saturating_sub(approvals);
    let blocking = items.iter().any(|i| i.level == Level::Block);
    let counts = match (approvals, questions) {
        (a, 0) => format!("{} waiting", plural(a, "approval", "approvals")),
        (0, q) if !blocking => format!("{} for later", plural(q, "question", "questions")),
        (0, q) => format!("{} waiting", plural(q, "question", "questions")),
        (a, q) => format!(
            "{} and {} waiting",
            plural(a, "approval", "approvals"),
            plural(q, "question", "questions")
        ),
    };
    let all_target = items.iter().all(|i| i.agent == target_agent);
    if all_target {
        return one_line(&format!("{counts}."));
    }
    let mut bots: Vec<&str> = Vec::new();
    for item in items {
        if !bots.contains(&item.name.as_str()) {
            bots.push(&item.name);
        }
    }
    let from = match bots.as_slice() {
        [one] => (*one).to_owned(),
        [first, second] => format!("{first} and {second}"),
        [first, rest @ ..] => format!("{first} and {} others", rest.len()),
        [] => return one_line(&format!("{counts}.")),
    };
    one_line(&format!("{counts} ({from})."))
}

fn plural(count: usize, one: &str, many: &str) -> String {
    if count == 1 {
        format!("1 {one}")
    } else {
        format!("{count} {many}")
    }
}

fn batch_id(agent: &str, latest_at: i64, first_seq: i64, count: usize) -> String {
    let suffix = format!(":{latest_at}:{first_seq}:{count}");
    let max_agent = 160usize.saturating_sub("batch:".len() + suffix.len());
    let cut: String = agent.chars().take(max_agent).collect();
    format!("batch:{cut}{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::Known;
    use crate::reach::{Why, settings::Budget};

    const NOW: i64 = 1_763_560_800_000;

    fn root() -> TreeRoot {
        TreeRoot {
            agent: "a-root".into(),
            name: "Builder".into(),
            conversation: "c-root".into(),
        }
    }

    fn ask(
        agent: &str,
        name: &str,
        seq: i64,
        kind: AskKind,
        level: Level,
        request: &str,
    ) -> PendingAsk {
        PendingAsk {
            id: format!("event:c-{agent}:{seq}"),
            agent: agent.into(),
            name: name.into(),
            conversation: format!("c-{agent}"),
            seq,
            at_ms: NOW + seq,
            kind,
            level,
            request: request.into(),
            text: match kind {
                AskKind::Approval => "Wants your yes to use shell.".into(),
                AskKind::Question => "Asks: Which branch?".into(),
            },
            engaged: false,
            bot_on: true,
            approvals: Approvals::Notify,
        }
    }

    fn moment(sent: &[i64]) -> Moment<'_> {
        Moment {
            now_ms: NOW,
            minute: 12 * 60,
            sent,
        }
    }

    #[test]
    fn a_single_ask_stays_an_individual_event_notice() {
        let items = [ask(
            "a-root",
            "Builder",
            5,
            AskKind::Question,
            Level::Block,
            "q1",
        )];
        let planned = plan(&Settings::default(), &root(), &items, moment(&[]));
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].id, "event:c-a-root:5");
        assert_eq!(planned[0].source_ids, vec!["event:c-a-root:5"]);
        assert_eq!(planned[0].notice["kind"], "event");
        assert_eq!(planned[0].notice["request"], "q1");
        assert_eq!(planned[0].decision.reach, Reach::Now);
        assert!(!planned[0].decision.counts);
    }

    #[test]
    fn several_asks_from_one_bot_or_tree_merge_into_one_grouped_notice() {
        let same_bot = [
            ask(
                "a-root",
                "Builder",
                5,
                AskKind::Approval,
                Level::Block,
                "c1",
            ),
            ask(
                "a-root",
                "Builder",
                7,
                AskKind::Approval,
                Level::Block,
                "c2",
            ),
        ];
        let planned = plan(&Settings::default(), &root(), &same_bot, moment(&[]));
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].notice["kind"], "needs_you_batch");
        assert_eq!(planned[0].notice["level"], "block");
        assert_eq!(planned[0].notice["count"], 2);
        assert_eq!(planned[0].notice["approvals"], 2);
        assert_eq!(planned[0].notice["questions"], 0);
        assert_eq!(planned[0].text, "2 approvals waiting.");
        assert_eq!(planned[0].decision.reach, Reach::Now);
        assert!(
            !planned[0].decision.counts,
            "an all-blocking batch never consumes proactive budget"
        );

        let tree = [
            ask("a-scout", "Scout", 2, AskKind::Approval, Level::Block, "c1"),
            ask(
                "a-runner",
                "Runner",
                4,
                AskKind::Question,
                Level::Block,
                "q1",
            ),
        ];
        let planned = plan(&Settings::default(), &root(), &tree, moment(&[]));
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].agent, "a-root");
        assert_eq!(planned[0].name, "Builder");
        assert_eq!(planned[0].notice["conversation"], "c-root");
        assert_eq!(
            planned[0].text,
            "1 approval and 1 question waiting (Scout and Runner)."
        );
        assert_eq!(planned[0].notice["items"].as_array().map(Vec::len), Some(2));
    }

    #[test]
    fn a_batch_belonging_to_one_worker_deep_links_to_that_worker() {
        let worker_only = [
            ask("a-scout", "Scout", 2, AskKind::Approval, Level::Block, "c1"),
            ask("a-scout", "Scout", 3, AskKind::Question, Level::Block, "q1"),
        ];
        let planned = plan(&Settings::default(), &root(), &worker_only, moment(&[]));
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].agent, "a-scout");
        assert_eq!(planned[0].name, "Scout");
        assert_eq!(planned[0].notice["agent"], "a-scout");
        assert_eq!(planned[0].notice["conversation"], "c-a-scout");
        assert_eq!(planned[0].text, "1 approval and 1 question waiting.");
        assert_eq!(planned[0].notice["items"].as_array().map(Vec::len), Some(2));
    }

    #[test]
    fn mixed_batch_charges_once_for_proactive_asks_and_keeps_urgent_items_when_budget_exhausted() {
        let settings = Settings {
            budget: Budget {
                per_hour: Some(1),
                per_day: Some(10),
            },
            ..Settings::default()
        };
        let mixed = [
            ask(
                "a-root",
                "Builder",
                5,
                AskKind::Approval,
                Level::Block,
                "c1",
            ),
            ask("a-root", "Builder", 6, AskKind::Question, Level::Ask, "q1"),
        ];
        // With room in the budget, both deliver together and charge once.
        let planned = plan(&settings, &root(), &mixed, moment(&[]));
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].decision.reach, Reach::Now);
        assert!(
            planned[0].decision.counts,
            "a mixed batch with a chargeable proactive ask charges once"
        );
        assert_eq!(planned[0].notice["count"], 2);

        // Once the budget is exhausted, the urgent block still delivers and the proactive ask waits.
        let exhausted = plan(&settings, &root(), &mixed, moment(&[NOW - 1_000]));
        assert_eq!(exhausted.len(), 2);
        assert_eq!(exhausted[0].decision.reach, Reach::Now);
        assert!(!exhausted[0].decision.counts);
        assert_eq!(exhausted[0].notice["request"], "c1");
        assert_eq!(exhausted[1].decision.reach, Reach::Held);
        assert_eq!(exhausted[1].decision.why, Some(Why::Budget));
        assert_eq!(exhausted[1].notice["request"], "q1");
    }

    #[test]
    fn non_blocking_questions_batched_together_count_once_against_budget() {
        let settings = Settings {
            budget: Budget {
                per_hour: Some(1),
                per_day: Some(10),
            },
            ..Settings::default()
        };
        let asks = [
            ask("a-root", "Builder", 1, AskKind::Question, Level::Ask, "q1"),
            ask("a-root", "Builder", 2, AskKind::Question, Level::Ask, "q2"),
        ];
        let planned = plan(&settings, &root(), &asks, moment(&[]));
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].level, Level::Ask);
        assert_eq!(planned[0].text, "2 questions for later.");
        assert_eq!(planned[0].decision.reach, Reach::Now);
        assert!(planned[0].decision.counts);
    }

    #[test]
    fn dnd_and_bot_off_are_respected_per_item_while_block_always_reaches_the_person() {
        let settings = Settings {
            dnd: true,
            ..Settings::default()
        };
        let mut quiet_worker = ask(
            "a-quiet",
            "Quiet",
            3,
            AskKind::Approval,
            Level::Block,
            "c-off",
        );
        quiet_worker.bot_on = false;
        let items = [
            ask(
                "a-root",
                "Builder",
                1,
                AskKind::Question,
                Level::Ask,
                "q-later",
            ),
            ask(
                "a-root",
                "Builder",
                2,
                AskKind::Approval,
                Level::Block,
                "c-now",
            ),
            quiet_worker,
        ];
        let planned = plan(&settings, &root(), &items, moment(&[]));
        assert_eq!(planned.len(), 3);
        // The blocking approval still reaches the person during DND (ADR 0195).
        assert_eq!(planned[0].decision.reach, Reach::Now);
        assert_eq!(planned[0].notice["request"], "c-now");
        // The non-blocking ask waits for quiet's end.
        assert_eq!(planned[1].decision.reach, Reach::Held);
        assert_eq!(planned[1].decision.why, Some(Why::Dnd));
        assert_eq!(planned[1].notice["request"], "q-later");
        // The silenced worker never leaks into a live alert.
        assert_eq!(planned[2].decision.reach, Reach::None);
        assert_eq!(planned[2].decision.why, Some(Why::BotOff));
        assert_eq!(planned[2].notice["request"], "c-off");
    }

    #[test]
    fn held_approvals_under_dnd_approvals_wait_group_together() {
        let settings = Settings {
            dnd: true,
            approvals: Approvals::Wait,
            ..Settings::default()
        };
        let mut a1 = ask(
            "a-root",
            "Builder",
            1,
            AskKind::Approval,
            Level::Block,
            "c1",
        );
        a1.approvals = Approvals::Wait;
        let mut a2 = ask(
            "a-root",
            "Builder",
            2,
            AskKind::Approval,
            Level::Block,
            "c2",
        );
        a2.approvals = Approvals::Wait;
        let planned = plan(&settings, &root(), &[a1, a2], moment(&[]));
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].decision.reach, Reach::Held);
        assert_eq!(planned[0].decision.why, Some(Why::Dnd));
        assert_eq!(planned[0].notice["kind"], "needs_you_batch");
        assert_eq!(planned[0].text, "2 approvals waiting.");
    }

    #[test]
    fn still_open_drops_answered_or_dismissed_approvals_and_questions() {
        let approval = ask(
            "a-root",
            "Builder",
            2,
            AskKind::Approval,
            Level::Block,
            "c1",
        );
        let blocking_q = ask(
            "a-root",
            "Builder",
            3,
            AskKind::Question,
            Level::Block,
            "q1",
        );
        let later_q = ask("a-root", "Builder", 4, AskKind::Question, Level::Ask, "q2");

        let mut events = vec![
            Event::user_message("Do it"),
            Event::reply_started("r1", "m"),
            Event::from_json(json!({
                "type": "approval_requested",
                "reply": "r1",
                "call_id": "c1",
                "name": "shell",
                "arguments": {},
            })),
            Event::Known(Known::QuestionAsked {
                reply: "r1".into(),
                call_id: "q1".into(),
                question: "Ship?".into(),
                questions: Vec::new(),
                later: false,
                lane: None,
            }),
            Event::Known(Known::QuestionAsked {
                reply: "r1".into(),
                call_id: "q2".into(),
                question: "Format?".into(),
                questions: Vec::new(),
                later: true,
                lane: None,
            }),
            Event::Known(Known::QuestionDeferred {
                call_id: "q2".into(),
                by_bot: true,
            }),
        ];
        assert!(still_open(&events, &approval));
        assert!(still_open(&events, &blocking_q));
        assert!(still_open(&events, &later_q));

        events.push(Event::from_json(json!({
            "type": "approval_answered",
            "reply": "r1",
            "call_id": "c1",
            "allowed": true,
        })));
        events.push(Event::Known(Known::QuestionAnswered {
            call_id: "q1".into(),
            answers: vec![json!("yes")],
            late: false,
            typed: false,
        }));
        events.push(Event::Known(Known::QuestionDismissed {
            call_id: "q2".into(),
            late: true,
        }));
        assert!(!still_open(&events, &approval));
        assert!(!still_open(&events, &blocking_q));
        assert!(!still_open(&events, &later_q));
    }
}
