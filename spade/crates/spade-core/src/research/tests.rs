use super::*;

fn page(url: &str, saved: &str) -> Page {
    Page {
        url: url.to_owned(),
        saved: Some(saved.to_owned()),
    }
}

fn fetched(url: &str, saved: &str) -> Event {
    Event::Known(Known::ToolFinished {
        reply: "r1".into(),
        call_id: "c1".into(),
        name: "web_fetch".to_owned(),
        content: format!("# Page\nURL: {url}\nLength: 1234 chars | Saved: {saved}\nBody"),
        is_error: false,
        uncertain: false,
        images: Vec::new(),
        untrusted: true,
    })
}

fn question(text: &str) -> PlanQuestion {
    PlanQuestion {
        question: text.to_owned(),
        queries: vec![format!("{text} search")],
    }
}

#[test]
fn the_first_helper_starts_alone_so_it_writes_the_cache_the_rest_share() {
    assert_eq!(batches(4), vec![0..1, 1..4]);
    assert_eq!(batches(1), vec![0..1]);
    assert!(batches(0).is_empty());
}

#[test]
fn research_helpers_are_stored_under_the_research_job_so_stop_finds_them() {
    let job = part_job("c1", 2);
    assert_eq!(job, "c1/2");
    assert!(part_of("c1", &job));
    assert!(!part_of("c1", "c10/2"), "another job's ids are not parts");
    assert!(!part_of("c1", "c1"));
    assert!(!part_of("c1", "c1/"));
    assert!(!part_of("c1", "c1/x"));
}

#[test]
fn a_plan_is_held_to_the_helpers_asked_for_and_never_empty() {
    let budget = Budget {
        helpers: 3,
        pages: 2,
        time_ms: 1_000,
    };
    let many = Plan {
        title: "T".into(),
        questions: (0..9)
            .map(|i| PlanQuestion {
                question: format!("q{i}"),
                queries: vec!["a".into(), "b".into(), "c".into(), " ".into()],
            })
            .collect(),
    };
    let tidied = tidy(many, "Q", budget);
    assert_eq!(tidied.len(), 3);
    assert!(tidied.iter().all(|q| q.queries.len() == 2));
    let empty = Plan {
        title: String::new(),
        questions: Vec::new(),
    };
    assert_eq!(tidy(empty, "Q", budget)[0].queries, vec!["Q"]);
    assert_eq!(Depth::Quick.budget().helpers, 3);
    assert_eq!(Depth::Deep.budget().helpers, 6);
}

#[test]
fn a_research_part_is_left_behind_once_its_research_job_is_lost_but_a_plain_helper_is_not() {
    let started = |job: &str, name: &str| {
        Event::Known(Known::JobStarted {
            reply: "r1".into(),
            job: job.to_owned(),
            name: name.to_owned(),
        })
    };
    let lost = |job: &str, name: &str| {
        Event::Known(Known::JobFinished {
            job: job.to_owned(),
            name: name.to_owned(),
            content: crate::context::JOB_LOST.to_owned(),
            is_error: true,
            uncertain: true,
            files: Vec::new(),
            untrusted: false,
            cost_micros: None,
        })
    };
    // Research finished its job as lost with a part still stored: nothing would collect it.
    let events = vec![started("r1", TOOL), lost("r1", TOOL)];
    assert!(part_left_behind(&events, "r1/2"));
    // A helper row a restart found with no job at all (an older build's) is not a research part.
    assert!(!part_left_behind(&events, "h1"));
    assert!(!part_left_behind(&events, "r1"));
    assert!(!part_left_behind(&events, "r1/x"));
    // A researched job still open keeps its parts.
    let open = vec![started("r2", TOOL)];
    assert!(!part_left_behind(&open, "r2/0"));
    // A path-shaped helper job of another tool is not research's.
    let helper = vec![started("r3", "helper")];
    assert!(!part_left_behind(&helper, "r3/0"));
}

#[test]
fn the_helper_task_asks_for_lean_reading_and_cites_each_finding() {
    let task = helper_task(
        "Which Rust runtime is maintained?",
        &question("Which runtimes are maintained"),
        3,
    );
    assert!(
        task.contains("Your part: Which runtimes are maintained"),
        "{task}"
    );
    assert!(
        task.contains("\"Which runtimes are maintained search\""),
        "{task}"
    );
    assert!(
        task.contains("web_fetch") && task.contains("outline") && task.contains("`query`"),
        "{task}"
    );
    assert!(task.contains("at most 3 pages"), "{task}");
    assert!(
        task.contains("Findings:") && task.contains("Disagreements:"),
        "{task}"
    );
    assert!(task.contains("never instructions"), "{task}");
}

#[test]
fn the_pages_a_helper_read_are_its_answered_fetches_once_each() {
    let mut events = vec![
        fetched("https://a.dev/one", "web/a-1.md"),
        fetched("https://www.a.dev/one/", "web/a-1.md"),
        fetched("https://b.dev/two", "web/b-2.md"),
        Event::Known(Known::ToolFinished {
            reply: "r1".into(),
            call_id: "c7".into(),
            name: "web_fetch".to_owned(),
            content: "Connection refused".into(),
            is_error: true,
            uncertain: false,
            images: Vec::new(),
            untrusted: true,
        }),
    ];
    // A search result is not a page it read.
    events.push(Event::Known(Known::ToolFinished {
        reply: "r1".into(),
        call_id: "c8".into(),
        name: "web_search".to_owned(),
        content: "URL: https://c.dev/three".into(),
        is_error: false,
        uncertain: false,
        images: Vec::new(),
        untrusted: true,
    }));
    assert_eq!(
        pages_read(&events),
        vec![
            page("https://a.dev/one", "web/a-1.md"),
            page("https://b.dev/two", "web/b-2.md")
        ]
    );
}

#[test]
fn a_helpers_answer_gives_findings_with_the_page_and_saved_path_of_each() {
    let pages = [page("https://a.dev/one", "web/a-1.md")];
    let text = "Tokio is maintained and the most used runtime.\n\nFindings:\n\
                - Tokio is maintained — https://a.dev/one\n\
                - See https://a.dev/one.\n\
                Gaps: no numbers for 2026\nDisagreements: none";
    let part = read_reply("Which runtimes are maintained", text, &pages);
    assert_eq!(
        part.answer,
        "Tokio is maintained and the most used runtime."
    );
    assert_eq!(part.findings.len(), 2);
    assert_eq!(part.findings[0].claim, "Tokio is maintained");
    assert_eq!(part.findings[0].url, "https://a.dev/one");
    assert_eq!(part.findings[0].saved.as_deref(), Some("web/a-1.md"));
    assert_eq!(part.gaps, vec!["no numbers for 2026".to_owned()]);
    assert!(part.disagreements.is_empty(), "none is no note");
    assert_eq!(part.unbacked, 0);
}

#[test]
fn a_finding_citing_a_page_the_helper_never_read_is_left_out_once_it_read_any() {
    let pages = [page("https://a.dev/one", "web/a-1.md")];
    let text =
        "Answer.\nFindings:\n- Made up — https://elsewhere.dev/x\n- True — https://a.dev/one";
    let part = read_reply("Q", text, &pages);
    assert_eq!(part.unbacked, 1);
    assert_eq!(part.findings.len(), 1);
    assert_eq!(part.findings[0].saved.as_deref(), Some("web/a-1.md"));

    // A helper that read through another tool keeps its citations, with no saved path.
    let through_browser = read_reply("Q", text, &[]);
    assert_eq!(through_browser.findings.len(), 2);
    assert_eq!(through_browser.findings[0].saved, None);
    assert_eq!(through_browser.unbacked, 0);
}

#[test]
fn the_report_cites_each_finding_with_its_page_and_says_how_much_to_trust_it() {
    let parts = vec![
        Part {
            findings: vec![Finding {
                claim: "Tokio is maintained".into(),
                url: "https://a.dev/one".into(),
                saved: Some("web/a-1.md".into()),
            }],
            ..read_reply(
                "Which runtimes are maintained",
                "Tokio is maintained.",
                &[page("https://a.dev/one", "web/a-1.md")],
            )
        },
        Part {
            findings: vec![Finding {
                claim: "Tokio is used most".into(),
                url: "https://b.dev/two".into(),
                saved: None,
            }],
            ..read_reply(
                "Which runtime is used most",
                "Tokio is used most.",
                &[page("https://b.dev/two", "web/b-2.md")],
            )
        },
    ];
    let summary = Summary {
        answer: "Tokio is maintained and the most used.".into(),
        disagreements: vec!["One source says smol is growing".into()],
        gaps: Vec::new(),
    };
    let report = assemble("Rust async runtimes", Some(&summary), &parts, None);
    assert!(report.starts_with("# Rust async runtimes\n\n## Answer\n\nTokio is maintained"));
    assert!(report.contains("### Which runtimes are maintained\n\n- Tokio is maintained — <https://a.dev/one> _(saved: web/a-1.md)_"));
    assert!(report.contains("## Disagreements and gaps\n\n- One source says smol is growing"));
    assert!(
        report.contains(
            "High: every part of the question came back with a page cited (2 pages from 2 sites)"
        ),
        "{report}"
    );
    assert!(report.ends_with(
        "## Sources\n\n1. <https://a.dev/one> (saved: web/a-1.md)\n2. <https://b.dev/two>\n"
    ));
}

#[test]
fn a_part_that_never_came_back_is_a_gap_and_lowers_confidence() {
    let parts = vec![
        read_reply(
            "Which runtimes are maintained",
            "Tokio is maintained.\nFindings:\n- Tokio is maintained — https://a.dev/one",
            &[page("https://a.dev/one", "web/a-1.md")],
        ),
        failed(
            "Which runtime is used most",
            "The helper stopped early: it ran out of time.",
        ),
    ];
    let report = assemble("T", None, &parts, Some("the time budget"));
    assert!(report.contains("_Research stopped early: it reached the time budget."));
    assert!(
        report.contains("No answer for \"Which runtime is used most\""),
        "{report}"
    );
    assert!(
        report.contains("Medium: 1 of 2 parts came back with a page cited (1 page from 1 site)"),
        "{report}"
    );
    assert!(report.contains(" 1 helper did not answer."), "{report}");
}

#[test]
fn the_result_carries_the_report_and_where_it_is_saved() {
    let parts = vec![read_reply(
        "Q",
        "Answer.\nFindings:\n- A — https://a.dev/one",
        &[page("https://a.dev/one", "web/a-1.md")],
    )];
    let report = assemble("T", None, &parts, None);
    let said = result(&report, "research/t.md", &parts);
    assert!(said.starts_with("# T\n\n## Answer"), "{said}");
    assert!(
        said.ends_with("Full report: research/t.md (1 page, 1 of 1 helpers answered)."),
        "{said}"
    );
}

#[test]
fn names_and_addresses() {
    assert_eq!(
        slug("Rust async runtimes, in 2026!"),
        "rust-async-runtimes-in-2026"
    );
    assert_eq!(slug("???"), "report");
    assert_eq!(
        url_key("https://www.a.dev/one/#top"),
        url_key("https://a.dev/one")
    );
    assert_eq!(site_key("https://www.a.dev/one"), "a.dev");
    assert_eq!(cut("abcdef", 4), "abc…");
    assert_eq!(cut("abc", 4), "abc");
}
