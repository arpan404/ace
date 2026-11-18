//! The realistic measures (ADR 0172, amendment 1), apart from the templates: the hand-labelled
//! hard set, tldr-pages, and, when a copy is given, real sessions and their end-to-end replay.
//! Every set is labelled by hand or by the reference labeller (`label.rs`), never by the model;
//! a call the labeller can't name counts as risky. Only aggregates are written.

use std::collections::BTreeSet;
use std::fmt::Write as _;

use spade_classify::{LOW_RISK, Model, PERSON_ONLY, Prediction, Screen, Subject};
use spade_core::effect::Effect;

use crate::eval::{HEADER, Measures, row};
use crate::label::{Label, label};
use crate::real::{self, Call, Kind};
use crate::replay::{self, Decide};
use crate::{data, hard, tldr};

/// One shell command to measure, with its label (`Unknown`: the labeller can't name it).
pub struct Item {
    pub command: String,
    pub workspace: Option<String>,
    pub label: Effect,
}

fn effect_of(label: Label) -> Effect {
    match label {
        Label::Sure(e) => e,
        Label::Unsure => Effect::Unknown,
    }
}

/// Why low-risk commands weren't settled, model alone.
#[derive(Debug, Default, Clone, Copy)]
pub struct Blockers {
    pub low: usize,
    pub outside: usize,
    pub hides: usize,
    pub unknown_part: usize,
    pub dropped: usize,
    /// No form that ignores configuration that could run a program (ADR 0172, amendment 3).
    pub no_form: usize,
    /// Eligible, but under the threshold (or raised).
    pub below: usize,
    /// Settled: the model's own decision was low-risk.
    pub settled: usize,
}

pub fn measure(model: &Model, items: &[Item]) -> (Measures, Blockers) {
    let mut m = Measures::default();
    let mut b = Blockers::default();
    for item in items {
        let p = model.predict(&Subject::Shell {
            command: &item.command,
            workspace: item.workspace.as_deref(),
        });
        let screen = model.screen(&p);
        count(&mut m, &p, screen, item.label);
        if LOW_RISK.contains(&item.label) {
            b.low += 1;
            // Settled is what the decision itself says; the rest by the first check that stops it.
            if screen == Screen::LowRisk {
                b.settled += 1;
            } else if p.reaches_outside {
                b.outside += 1;
            } else if p.hides {
                b.hides += 1;
            } else if !p.known {
                b.unknown_part += 1;
            } else if p.dropped {
                b.dropped += 1;
            } else if !p.hardened {
                b.no_form += 1;
            } else {
                b.below += 1;
            }
        }
    }
    (m, b)
}

pub fn count(m: &mut Measures, p: &Prediction, screen: Screen, label: Effect) {
    let low = LOW_RISK.contains(&label);
    let person = PERSON_ONLY.contains(&label);
    m.n += 1;
    m.correct += usize::from(p.top().0 == label);
    m.low += usize::from(low);
    m.risky += usize::from(!low);
    m.person += usize::from(person);
    match screen {
        Screen::LowRisk => {
            m.settled += 1;
            if low {
                m.settled_right += 1;
            } else {
                m.false_low += 1;
            }
        }
        Screen::Person(effect) => {
            m.raised += 1;
            m.raised_right += usize::from(person);
            m.raised_exact += usize::from(effect == label);
        }
        Screen::Abstain => {}
    }
}

const BLOCKERS: &str = "| set | low-risk calls | outside the folder | hides what it runs | a part never seen as low-risk | past a bound | no hard form | eligible, under the threshold | settled |\n|---|---|---|---|---|---|---|---|---|";

fn blockers_row(name: &str, b: &Blockers) -> String {
    let share = |n: usize| format!("{:.1}%", 100.0 * n as f64 / b.low.max(1) as f64);
    format!(
        "| {name} | {} | {} | {} | {} | {} | {} | {} | {} |",
        b.low,
        share(b.outside),
        share(b.hides),
        share(b.unknown_part),
        share(b.dropped),
        share(b.no_form),
        share(b.below),
        share(b.settled)
    )
}

pub fn hard_items() -> Vec<Item> {
    hard::HARD
        .iter()
        .map(|(command, effect)| Item {
            command: command.replace("{ws}", data::WORKSPACE),
            workspace: Some(data::WORKSPACE.to_owned()),
            label: *effect,
        })
        .collect()
}

/// One of five buckets for a tldr page, by a hash of its name: a page's examples always fall in
/// the same set, so a held-out page shares no form with training.
fn page_bucket(page: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in page.bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    h % 5
}

/// Whether a tldr page is held out of the measured model's training: its test set.
pub fn tldr_test_page(page: &str) -> bool {
    page_bucket(page) == 0
}

/// Whether a tldr page is the measured model's validation.
pub fn tldr_val_page(page: &str) -> bool {
    page_bucket(page) == 1
}

pub fn tldr_items(examples: &[tldr::Example], keep: impl Fn(&tldr::Example) -> bool) -> Vec<Item> {
    examples
        .iter()
        .filter(|e| keep(e))
        .map(|e| Item {
            command: e.command.clone(),
            workspace: Some(data::WORKSPACE.to_owned()),
            label: effect_of(label(&e.command, Some(&e.description))),
        })
        .collect()
}

/// The distinct shell commands of the real sessions, each under its own folder.
pub fn real_items(calls: &[Call], with_workspace: bool) -> Vec<Item> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for call in calls {
        let Kind::Shell(command) = &call.kind else {
            continue;
        };
        if !seen.insert((command.clone(), call.workspace.clone())) {
            continue;
        }
        out.push(Item {
            command: command.clone(),
            workspace: with_workspace.then(|| call.workspace.clone()),
            label: effect_of(label(&real::relative_to(command, &call.workspace), None)),
        });
    }
    out
}

/// The label counts of a set, for the report.
pub fn labels(items: &[Item]) -> String {
    let mut counts: std::collections::BTreeMap<&str, usize> = Default::default();
    for item in items {
        *counts
            .entry(if item.label == Effect::Unknown {
                "unsure"
            } else {
                item.label.name()
            })
            .or_default() += 1;
    }
    counts
        .iter()
        .map(|(k, v)| format!("{k} {v}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The realistic sets' section: model alone, why low-risk calls weren't settled, and, with real
/// sessions, the end-to-end replay under each wiring given.
/// Drops from `items` the calls whose folded signature is in the fit set, so an evaluation set
/// shares no call the model can't tell from a fit call; returns how many were dropped.
fn hold_out(items: Vec<Item>, fit: &crate::overlap::Fit) -> (Vec<Item>, usize) {
    let before = items.len();
    let kept: Vec<Item> = items
        .into_iter()
        .filter(|i| {
            !fit.has(crate::overlap::command_signature(
                &i.command,
                i.workspace.as_deref(),
            ))
        })
        .collect();
    let dropped = before - kept.len();
    (kept, dropped)
}

pub fn report(
    model: &Model,
    tldr: Option<&[tldr::Example]>,
    real: Option<&[Call]>,
    fit: &crate::overlap::Fit,
    wirings: &[(&str, Decide<'_>, bool)],
) -> String {
    let mut r = String::new();
    let mut dropped: Vec<(String, usize)> = Vec::new();
    let mut held = |name: &str, items: Vec<Item>| {
        let (kept, n) = hold_out(items, fit);
        dropped.push((name.to_owned(), n));
        kept
    };
    // The `bool` is whether the set is synthetic (hand-written or templated), so its commands may
    // be printed under CLASSIFY_DUMP. Real sessions are the person's and are never printed.
    let mut sets: Vec<(String, Vec<Item>, bool)> = vec![(
        "hand-labelled hard set".to_owned(),
        held("hand-labelled hard set", hard_items()),
        true,
    )];
    if let Some(examples) = tldr {
        let _ = writeln!(r, "\ntldr-pages at commit `{}` (CC BY 4.0).", tldr::COMMIT);
        sets.push((
            "tldr-pages, held-out pages".to_owned(),
            held(
                "tldr-pages, held-out pages",
                tldr_items(examples, |e| tldr_test_page(&e.page)),
            ),
            true,
        ));
    }
    if let Some(calls) = real {
        sets.push((
            "real sessions, distinct commands, with the folder".to_owned(),
            held("real sessions, with the folder", real_items(calls, true)),
            false,
        ));
        sets.push((
            "real sessions, distinct commands, no folder passed to the classifier".to_owned(),
            held("real sessions, no folder", real_items(calls, false)),
            false,
        ));
    }
    if let Some(path) = std::env::var_os("CLASSIFY_EVAL_OUT") {
        let mut lines = String::new();
        for (name, items, synthetic) in &sets {
            if !*synthetic {
                continue;
            }
            for item in items {
                let _ = writeln!(
                    lines,
                    "{}\t{}\t{}",
                    name,
                    item.label.name(),
                    item.command.replace(['\t', '\n'], " ")
                );
            }
        }
        let _ = std::fs::write(path, lines);
    }
    let _ = writeln!(
        r,
        "\nHeld out of the fit set by folded signature (ADR 0172, amendment 6): {}.",
        dropped
            .iter()
            .map(|(name, n)| format!("{name} {n}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let _ = writeln!(
        r,
        "\n## Realistic sets\n\nLabelled by hand (the hard set) or by the reference labeller \
         (`classify-train/src/label.rs`: explicit tables, Spade's rules and tldr's own \
         descriptions), never by the model. A command the labeller can't name counts as risky, so \
         a settled one is a false low-risk here. The model alone, every call shown to it:\n"
    );
    for (name, items, _) in &sets {
        let _ = writeln!(r, "- {name}: {}", labels(items));
    }
    let _ = writeln!(r, "\n{HEADER}");
    let mut blockers = Vec::new();
    for (name, items, synthetic) in &sets {
        dump(model, items, name, *synthetic);
        let (m, b) = measure(model, items);
        let _ = writeln!(r, "{}", row(name, &m));
        blockers.push((name.clone(), b));
    }
    let _ = writeln!(
        r,
        "{}",
        row(
            "hand-labelled connector calls (raise only, as wired)",
            &crate::connectors::measure(model)
        )
    );
    let _ = writeln!(
        r,
        "\nWhy low-risk calls weren't settled (the first check that stops each, in this \
         order):\n\n{BLOCKERS}"
    );
    for (name, b) in &blockers {
        let _ = writeln!(r, "{}", blockers_row(name, b));
    }
    if let Some(calls) = real {
        let _ = writeln!(
            r,
            "\n## End to end: real sessions through the whole gate\n\nEvery call of the real \
             sessions, replayed as a Spade bot with no sandbox would meet it: Spade's rules first \
             (`effect::route` with the shell classifier's reading), then the classifier on what \
             they send to review. A command's output and files Spade didn't write are untrusted, \
             so after a thread's first such call untrusted content is in view ({} of {} shell \
             commands). Provider-only tools with no Spade counterpart are left out. These sessions often \
             work outside the folder they were started in (sibling worktrees, `/tmp`, the home \
             folder), which the classifier never settles; the rows placed in the folder each \
             thread worked in (the absolute folder it `cd`s into most) show the same calls as a \
             bot whose own folder that is would make them.\n\n{}",
            replay::replay(calls, model, wirings[0].1, wirings[0].2).tainted,
            calls
                .iter()
                .filter(|c| matches!(c.kind, Kind::Shell(_)))
                .count(),
            replay::HEADER
        );
        let mut causes = Vec::new();
        let placed = replay::placed(calls);
        for (name, decide, with_workspace) in wirings {
            let o = replay::replay(calls, model, *decide, *with_workspace);
            let _ = writeln!(r, "{}", replay::row(name, &o));
            causes.push((replay::causes_row(name, &o), (name.to_string(), o)));
        }
        for (name, decide, with_workspace) in wirings {
            let name = format!("{name}, each thread placed in the folder it worked in");
            let o = replay::replay(&placed, model, *decide, *with_workspace);
            let _ = writeln!(r, "{}", replay::row(&name, &o));
            causes.push((replay::causes_row(&name, &o), (name, o)));
        }
        let _ = writeln!(r, "\n{}", replay::CAUSES);
        for (line, _) in &causes {
            let _ = writeln!(r, "{line}");
        }
        let _ = writeln!(r);
        for (_, (name, o)) in &causes {
            let _ = writeln!(
                r,
                "- {name}: the rules found {}; the classifier abstained on what it could settle for: {}.",
                replay::tally(&o.found),
                replay::tally(&o.abstained)
            );
        }
    }
    r
}

/// For whoever tunes the classifier, on this machine only: a sample of the commands each check
/// stopped, printed to stderr when `CLASSIFY_DUMP` is set and only for synthetic sets
/// (`show_commands`). Real-session commands are the person's, so they are never printed, here or
/// anywhere: real sessions are reported only as aggregate counts. Never written to a file.
pub fn dump(model: &Model, items: &[Item], name: &str, show_commands: bool) {
    if !show_commands || std::env::var_os("CLASSIFY_DUMP").is_none() {
        return;
    }
    let mut shown = std::collections::BTreeMap::<&str, usize>::new();
    for item in items {
        let p = model.predict(&Subject::Shell {
            command: &item.command,
            workspace: item.workspace.as_deref(),
        });
        let screen = model.screen(&p);
        let why = if LOW_RISK.contains(&item.label) {
            if p.reaches_outside {
                "outside"
            } else if p.hides {
                "hides"
            } else if !p.known {
                "unknown"
            } else if p.low_risk() < model.header().low {
                "below"
            } else {
                continue;
            }
        } else if screen == Screen::LowRisk {
            "FALSE-LOW"
        } else if matches!(screen, Screen::Person(_)) && !PERSON_ONLY.contains(&item.label) {
            "false-raise"
        } else {
            continue;
        };
        let n = shown.entry(why).or_default();
        *n += 1;
        if *n <= 25 {
            let short: String = item.command.chars().take(160).collect();
            eprintln!(
                "{name} {why} {:?} p={:.3} {short:?}",
                item.label,
                p.low_risk()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_blocker_tables_settled_share_is_the_low_risk_recall_and_every_call_is_counted_once() {
        let Some(model) = Model::embedded() else {
            panic!("the built-in model doesn't read");
        };
        let (m, b) = measure(model, &hard_items());
        assert_eq!(b.settled, m.settled_right);
        assert_eq!(b.low, m.low);
        assert_eq!(
            b.outside + b.hides + b.unknown_part + b.dropped + b.no_form + b.below + b.settled,
            b.low
        );
        // A build has no hard form, and is counted there.
        let builds = [Item {
            command: "cargo test".to_owned(),
            workspace: Some(data::WORKSPACE.to_owned()),
            label: Effect::WriteLocal,
        }];
        let (_, b) = measure(model, &builds);
        assert_eq!((b.no_form, b.settled), (1, 0));
    }
}
