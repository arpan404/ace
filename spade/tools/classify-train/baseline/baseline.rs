#![allow(dead_code)]
//! The true `main` baseline (ADR 0172, amendment 6): main's shipped model (`99f56e23`) run with
//! main's own decision logic, on the same evaluation sets as the shipped weights, so the
//! before/after comparison is honest. Built in a clean `origin/main` worktree against main's
//! crates; it uses no API this PR added. The eval sets and the reference labeller are
//! model-independent, so the only difference from the "after" run is the model and its logic.

mod connectors;
mod hard;
mod label;
mod real;
mod tldr;

use std::path::Path;

use serde_json::json;
use spade_classify::{Effect, Mcp, Model, Reviewing, Screen, Subject};
use spade_core::autonomy::{self, Class};
use spade_core::effect::{self, Granted, Place as Where, Route};
use spade_core::gate;
use spade_core::tools::Risk;

use label::{Label, label};
use real::{Call, Kind};

const WORKSPACE: &str = "/spade/workspace/bot";

#[derive(Default, Clone, Copy)]
struct M {
    n: usize,
    low: usize,
    settled: usize,
    settled_right: usize,
    risky: usize,
    false_low: usize,
    person: usize,
    raised: usize,
    raised_right: usize,
}

fn ratio(a: usize, b: usize) -> String {
    if b == 0 {
        "-".into()
    } else {
        format!("{:.4}", a as f64 / b as f64)
    }
}

fn row(name: &str, m: &M) -> String {
    format!(
        "| {name} | {} | {} | {} | {} ({}/{}) | {} | {} |",
        m.n,
        ratio(m.settled_right, m.settled),
        ratio(m.settled_right, m.low),
        ratio(m.false_low, m.risky),
        m.false_low,
        m.risky,
        ratio(m.raised_right, m.raised),
        ratio(m.raised_right, m.person),
    )
}

/// Main's model alone: `model.screen` (main settles reads and folder writes).
fn measure(model: &Model, items: &[(String, Effect)]) -> M {
    let mut m = M::default();
    for (command, label) in items {
        let p = model.predict(&Subject::Shell {
            command,
            workspace: Some(WORKSPACE),
        });
        let low = matches!(label, Effect::Read | Effect::WriteLocal);
        let person = spade_classify::PERSON_ONLY.contains(label);
        m.n += 1;
        m.low += usize::from(low);
        m.risky += usize::from(!low);
        m.person += usize::from(person);
        match model.screen(&p) {
            Screen::LowRisk => {
                m.settled += 1;
                if low {
                    m.settled_right += 1;
                } else {
                    m.false_low += 1;
                }
            }
            Screen::Person(_) => {
                m.raised += 1;
                m.raised_right += usize::from(person);
            }
            Screen::Abstain => {}
        }
    }
    m
}

fn effect_of(l: Label) -> Effect {
    match l {
        Label::Sure(e) => e,
        Label::Unsure => Effect::Unknown,
    }
}

fn hard_items() -> Vec<(String, Effect)> {
    hard::HARD
        .iter()
        .map(|(c, e)| (c.replace("{ws}", WORKSPACE), *e))
        .collect()
}

fn tldr_test_page(page: &str) -> bool {
    let mut h: u32 = 0x811c_9dc5;
    for b in page.bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    h % 5 == 0
}

fn tldr_items(examples: &[tldr::Example]) -> Vec<(String, Effect)> {
    examples
        .iter()
        .filter(|e| tldr_test_page(&e.page))
        .map(|e| {
            (
                e.command.clone(),
                effect_of(label(&e.command, Some(&e.description))),
            )
        })
        .collect()
}

fn real_items(calls: &[Call]) -> Vec<(String, Effect)> {
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for call in calls {
        let Kind::Shell(command) = &call.kind else {
            continue;
        };
        if !seen.insert((command.clone(), call.workspace.clone())) {
            continue;
        }
        out.push((
            command.clone(),
            effect_of(label(&real::relative_to(command, &call.workspace), None)),
        ));
    }
    out
}

/// Main's end-to-end replay: main's `effect::route` first, then main's `screen`/`raise` when it
/// reviews. The classifier was shown no folder (`workspace: None`), as on main.
#[derive(Default)]
struct E2e {
    calls: usize,
    rules_run: usize,
    rules_person: usize,
    refused: usize,
    classifier_run: usize,
    classifier_person: usize,
    reviewer: usize,
    person_seen: usize,
    raised_right: usize,
    false_low: usize,
}

const ACE_READ_ONLY: &[&str] = &[
    "agents_status", "automations_list", "context", "guide", "handoff_read", "html_preview",
    "machines", "market_read", "models", "projects_find", "thread_read", "threads_find", "wait",
    "tools_find", "browser_screenshot", "browser_snapshot", "browser_find", "browser_logs",
    "browser_wait_for", "browser_tabs", "browser_history", "browser_measure", "screen_state",
    "screen_apps",
];

fn e2e(calls: &[Call], model: &Model) -> E2e {
    let mut o = E2e::default();
    let mut thread = "";
    let mut in_view = false;
    for call in calls {
        if call.thread != thread {
            thread = &call.thread;
            in_view = false;
        }
        let tainted = in_view;
        match &call.kind {
            Kind::Other => continue,
            Kind::FileRead => {
                o.calls += 1;
                o.rules_run += 1;
                in_view = true;
            }
            Kind::FileWrite => {
                o.calls += 1;
                o.rules_run += 1;
            }
            Kind::Mcp { server, tool, arguments } => {
                o.calls += 1;
                let risk = if server == "ace" && ACE_READ_ONLY.contains(&tool.as_str()) {
                    Risk::Read
                } else {
                    Risk::Write
                };
                let declared = effect::ace(tool, risk, None, arguments);
                let route = effect::route(effect::Call {
                    tool,
                    rule: gate::decide(risk, false, tainted),
                    risk,
                    always: false,
                    effect: Some(declared),
                    remembered: None,
                    place: Where::Host,
                    tainted,
                    credentials: autonomy::reaches_credentials(arguments),
                    standing: false,
                    fits: autonomy::fits_review(arguments, &[]),
                    granted: Granted::No,
                    checkpointed: false,
                    target: None,
                });
                count_route(&mut o, &route);
                if tool.starts_with("browser_") {
                    in_view = true;
                }
            }
            Kind::Shell(command) => {
                o.calls += 1;
                shell_e2e(&mut o, call, command, tainted, model);
                in_view = true;
            }
        }
    }
    o
}

fn count_route(o: &mut E2e, route: &Route) {
    match route {
        Route::Run => o.rules_run += 1,
        Route::Ask { .. } => o.rules_person += 1,
        Route::Refuse(_) => o.refused += 1,
        Route::Review(_) => o.reviewer += 1,
    }
}

fn shell_e2e(o: &mut E2e, call: &Call, command: &str, tainted: bool, model: &Model) {
    let arguments = json!({ "command": command });
    let classed = autonomy::classify_shell(&arguments, &autonomy::shell::Lexical);
    let credentials = classed.credentials || autonomy::reaches_credentials(&arguments);
    let route = effect::route(effect::Call {
        tool: autonomy::SHELL,
        rule: gate::decide(Risk::Write, false, tainted),
        risk: Risk::Write,
        always: false,
        effect: Some(Effect::WriteLocal),
        remembered: None,
        place: Where::Unsandboxed(classed.class),
        tainted,
        credentials,
        standing: false,
        fits: autonomy::fits_review(&arguments, &classed.shown),
        granted: Granted::No,
        checkpointed: false,
        target: None,
    });
    let Route::Review(concern) = route else {
        count_route(o, &route);
        return;
    };
    let reviewing = Reviewing {
        plain_command: classed.class == Class::Inside && !credentials,
        tainted,
        runs_files: !classed.shown.is_empty(),
        standing: false,
        concern: concern.is_some(),
    };
    let truth = label(&real::relative_to(command, &call.workspace), None);
    let person = matches!(truth, Label::Sure(e) if spade_classify::PERSON_ONLY.contains(&e));
    o.person_seen += usize::from(person);
    // Main shows the classifier no folder.
    let p = model.predict(&Subject::Shell {
        command,
        workspace: None,
    });
    let screen = if reviewing.may_settle() {
        model.screen(&p)
    } else {
        model.raise(&p)
    };
    match screen {
        Screen::LowRisk => {
            o.classifier_run += 1;
            if !matches!(truth, Label::Sure(Effect::Read) | Label::Sure(Effect::WriteLocal)) {
                o.false_low += 1;
            }
        }
        Screen::Person(_) => {
            o.classifier_person += 1;
            o.raised_right += usize::from(person);
        }
        Screen::Abstain => o.reviewer += 1,
    }
}

/// The deduped public eval sets exported by the shipped build (hand-labelled hard set and
/// tldr-pages held-out pages), so main is measured on exactly the same held-out calls.
fn load_public(path: &str, set: &str) -> Vec<(String, Effect)> {
    let text = std::fs::read_to_string(path).expect("eval-public file");
    text.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let name = parts.next()?;
            let label = parts.next()?;
            let command = parts.next()?;
            (name == set).then(|| (command.to_owned(), parse_effect(label)))
        })
        .collect()
}

fn parse_effect(name: &str) -> Effect {
    Effect::ALL
        .into_iter()
        .find(|e| e.name() == name)
        .unwrap_or(Effect::Unknown)
}

fn connector_measure(model: &Model) -> M {
    let mut m = M::default();
    for (name, arguments, label) in connectors::calls() {
        let hints = Mcp {
            read_only: label == Effect::Read,
            annotated: true,
            declared: Some(if label == Effect::Read { Effect::Read } else { Effect::Network }),
        };
        let p = model.predict(&Subject::Tool { name, arguments: &arguments, hints });
        let person = spade_classify::PERSON_ONLY.contains(&label);
        m.n += 1;
        m.person += usize::from(person);
        // Raise-only as wired: a low-risk reading is not a settle for a connector.
        match model.raise(&p) {
            Screen::Person(_) => {
                m.raised += 1;
                m.raised_right += usize::from(person);
            }
            _ => {}
        }
    }
    m
}

fn pct(n: usize, d: usize) -> String {
    format!("{:.1}%", 100.0 * n as f64 / d.max(1) as f64)
}

fn main() {
    let mut args = std::env::args().skip(1);
    let mut tldr_dir = None;
    let mut real_dir = None;
    let mut public = None;
    while let Some(a) = args.next() {
        match a.as_str() {
            "--tldr" => tldr_dir = args.next(),
            "--real" => real_dir = args.next(),
            "--eval-public" => public = args.next(),
            _ => {}
        }
    }
    let model = Model::embedded().expect("main's built-in model");
    println!("Main baseline, model `{}`.\n", model.id());
    println!(
        "| set | n | low-risk precision | low-risk recall | false-low-risk | person precision | person recall |"
    );
    println!("|---|---|---|---|---|---|---|");
    // Use the shipped build's deduped public sets when given, so the sets are identical.
    let hard = match &public {
        Some(f) => load_public(f, "hand-labelled hard set"),
        None => hard_items(),
    };
    println!("{}", row("hand-labelled hard set", &measure(model, &hard)));
    let tldr_items_v = match (&public, &tldr_dir) {
        (Some(f), _) => Some(load_public(f, "tldr-pages, held-out pages")),
        (None, Some(dir)) => Some(tldr_items(&tldr::read(Path::new(dir)).expect("tldr"))),
        _ => None,
    };
    if let Some(items) = tldr_items_v {
        println!("{}", row("tldr-pages, held-out pages", &measure(model, &items)));
    }
    println!("{}", row("connector calls (raise only)", &connector_measure(model)));
    if let Some(dir) = &real_dir {
        let calls = real::read(Path::new(dir)).expect("real");
        println!(
            "{}",
            row("real sessions, distinct commands", &measure(model, &real_items(&calls)))
        );
        let o = e2e(&calls, model);
        println!("\nEnd to end (as recorded):");
        println!(
            "| calls | run by the rules | run on the classifier | person by rules | person raised | refused | reviewer | decided | false low-risk | person-only raised |"
        );
        println!("|---|---|---|---|---|---|---|---|---|---|");
        let decided = o.rules_run + o.rules_person + o.refused + o.classifier_run + o.classifier_person;
        println!(
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} of {} |",
            o.calls,
            pct(o.rules_run, o.calls),
            pct(o.classifier_run, o.calls),
            pct(o.rules_person, o.calls),
            pct(o.classifier_person, o.calls),
            pct(o.refused, o.calls),
            pct(o.reviewer, o.calls),
            pct(decided, o.calls),
            o.false_low,
            o.raised_right,
            o.person_seen,
        );
    }
}
