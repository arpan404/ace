//! The Working line's few words on what a bot is doing right now: "Analyzing the flight prices",
//! "Searching the web for flights", "Running the tests". In order, from the model's own headline
//! as it reasons, the step of its plan in progress, then a phrase for the tool it runs. Never a
//! raw tool id and never "Running command": a step with nothing clear to say has no phrase, and
//! the line says "Working". Pure; secrets are hidden and the words cut short before they leave.

use serde_json::Value;

use crate::redact;

/// The most words a phrase keeps.
pub const MAX_WORDS: usize = 6;
/// The most characters a phrase keeps.
pub const MAX_CHARS: usize = 48;

/// Words a cut phrase never ends on: "Reading the" reads as cut, "Reading" does not.
const DANGLING: &[&str] = &[
    "a", "an", "the", "of", "to", "for", "in", "on", "and", "or", "with", "from", "by", "at",
    "its", "your", "my", "our", "their", "into", "about",
];

/// `text` as one short plain line: markdown marks and control characters gone, secrets hidden,
/// at most `MAX_WORDS` words and `MAX_CHARS` characters, never ending on a dangling word.
pub fn short(text: &str) -> Option<String> {
    let plain: String = redact::text(text)
        .chars()
        .map(|c| match c {
            '*' | '_' | '`' | '#' | '>' | '[' | ']' | '~' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let mut words: Vec<&str> = plain.split_whitespace().take(MAX_WORDS).collect();
    while words.join(" ").chars().count() > MAX_CHARS && words.len() > 1 {
        words.pop();
    }
    let cut = plain.split_whitespace().count() > words.len();
    while cut
        && words.len() > 1
        && words
            .last()
            .is_some_and(|w| DANGLING.contains(&w.to_lowercase().as_str()))
    {
        words.pop();
    }
    let line = words.join(" ");
    let line = line.trim_end_matches([':', ',', ';', '.', '-']).trim();
    if line.is_empty() {
        return None;
    }
    let line: String = line.chars().take(MAX_CHARS).collect();
    Some(capitalised(&line))
}

/// The newest headline in a model's reasoning: a line that is all bold (`**Comparing flight
/// prices**`, as Codex-style summaries begin each part) or a markdown heading. `None` until one
/// has closed.
pub fn headline(reasoning: &str) -> Option<String> {
    reasoning.lines().rev().find_map(|line| {
        let line = line.trim();
        let inner = line
            .strip_prefix("**")
            .and_then(|rest| rest.strip_suffix("**"))
            .filter(|inner| !inner.contains("**"))
            .or_else(|| {
                let heading = line.trim_start_matches('#');
                (heading.len() < line.len() && heading.starts_with(' ')).then_some(heading)
            })?;
        // A headline is a few words, not a bold paragraph.
        (inner.split_whitespace().count() <= 12)
            .then(|| short(inner))
            .flatten()
    })
}

/// The step of a `todo` plan in progress: its first item not done. `None` when every item is.
pub fn plan_step(arguments: &Value) -> Option<String> {
    arguments
        .get("items")?
        .as_array()?
        .iter()
        .find(|item| !item.get("done").and_then(Value::as_bool).unwrap_or(false))
        .and_then(|item| item.get("text")?.as_str())
        .and_then(short)
}

fn field<'a>(arguments: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| arguments.get(*key)?.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// `src/auth/login.ts` → `login.ts`.
fn file_name(path: &str) -> &str {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
}

/// `https://www.example.com/a` → `example.com`.
fn host(url: &str) -> Option<&str> {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let host = rest.split(['/', '?', '#', ':']).next()?;
    let host = host.strip_prefix("www.").unwrap_or(host);
    (!host.is_empty() && host.contains('.')).then_some(host)
}

fn capitalised(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// A phrase with `what` after it, cut as a whole: "Searching the web for flights to Oslo".
fn with(lead: &str, what: Option<&str>) -> String {
    match what.and_then(|w| short(&format!("{lead} {w}"))) {
        Some(line) => line,
        None => lead.to_owned(),
    }
}

/// Leading words a research question starts with that say nothing about its topic.
const ASKING: &[&str] = &[
    "what", "which", "who", "where", "when", "how", "why", "is", "are", "do", "does", "can",
    "find", "list", "the", "a", "an", "me", "some", "best", "top", "good",
];

/// "Which investors fund climate startups?" → "investors fund climate startups".
fn topic(question: &str) -> Option<String> {
    let words: Vec<&str> = question
        .trim_end_matches(['?', '.', '!'])
        .split_whitespace()
        .skip_while(|w| ASKING.contains(&w.to_lowercase().as_str()))
        .collect();
    (!words.is_empty()).then(|| {
        let mut line = words.join(" ");
        if let Some(first) = line.get(..1) {
            line = first.to_lowercase() + &line[1..];
        }
        line
    })
}

fn count_of(arguments: &Value, key: &str) -> Option<usize> {
    arguments
        .get(key)?
        .as_array()
        .map(Vec::len)
        .filter(|n| *n > 0)
}

fn agents(n: usize) -> String {
    if n == 1 {
        "an ace agent".to_owned()
    } else {
        format!("{n} ace agents")
    }
}

/// What a running tool call means, in a few words; `None` when nothing clear can be said.
/// `call_tool` is read as the tool it reaches; app tools (`notion__search`) by their app.
pub fn tool(name: &str, arguments: &Value) -> Option<String> {
    if name == "call_tool"
        && let Some(inner) = field(arguments, &["name", "tool"])
    {
        let inner_args = arguments.get("arguments").unwrap_or(&Value::Null);
        return tool(inner, inner_args);
    }
    // An app's tool: in the same verbs the activity log uses (`plain`), cut short.
    if let Some(phrase) = super::plain::app_doing(name) {
        return short(&phrase);
    }
    let base = name.split_once("__").map_or(name, |(_, base)| base);
    let base = base.strip_prefix("ace_").unwrap_or(base);
    Some(match base {
        "shell" => return field(arguments, &["command"]).and_then(command),
        "web_search" => match field(arguments, &["query", "q"]) {
            Some(query) => with("Searching the web for", Some(query)),
            None => "Searching the web".to_owned(),
        },
        "web_fetch" | "browser_open" => match field(arguments, &["url"]).and_then(host) {
            Some(host) => with("Reading", Some(host)),
            None => "Reading a web page".to_owned(),
        },
        "research" => match field(arguments, &["question", "query", "topic"]).and_then(topic) {
            Some(topic) => with("Researching", Some(&topic)),
            None => "Researching".to_owned(),
        },
        "memory_search" => "Checking its notes".to_owned(),
        "workspace_read" => file(arguments, "Reading", "Reading a file"),
        "workspace_edit" => file(arguments, "Editing", "Editing a file"),
        "workspace_write" => file(arguments, "Writing", "Writing a file"),
        "workspace_search" => "Searching its files".to_owned(),
        "workspace_list" => "Looking through its files".to_owned(),
        "todo" => plan_step(arguments).unwrap_or_else(|| "Planning".to_owned()),
        "delegate" => match count_of(arguments, "tasks") {
            Some(n) => format!("Handing work to {}", agents(n)),
            None => "Handing work to ace agents".to_owned(),
        },
        "wait" => match count_of(arguments, "threadIds") {
            Some(n) => format!("Waiting on {}", agents(n)),
            None => "Waiting on ace agents".to_owned(),
        },
        // A tool the table doesn't know reads by its id in words: never on this line.
        _ if !super::words::known(name) => return None,
        _ => super::words::tool_words(name).doing,
    })
}

fn file(arguments: &Value, verb: &str, fallback: &str) -> String {
    match field(arguments, &["path"]).map(file_name) {
        Some(name) => with(verb, Some(name)),
        None => fallback.to_owned(),
    }
}

/// Words a shell command line starts with that don't say what it does.
const PREFIXES: &[&str] = &["sudo", "time", "nice", "env", "command", "exec", "nohup"];

/// The command a shell line runs, in a few words: "Running the tests", "Building",
/// "Reading auth.ts". The first part of a chain that says something wins; `cd` and the like
/// say nothing.
pub fn command(line: &str) -> Option<String> {
    line.split(['|', ';', '&', '\n'])
        .find_map(|part| segment(part.trim()))
}

fn segment(part: &str) -> Option<String> {
    let mut words = part
        .split_whitespace()
        .skip_while(|w| PREFIXES.contains(w) || (w.contains('=') && !w.starts_with('-')))
        .peekable();
    // `timeout 60 cargo test`.
    if words.peek() == Some(&"timeout") {
        words.next();
        words.next();
    }
    let words: Vec<&str> = words.collect();
    let program = file_name(words.first()?);
    let args: Vec<&str> = words[1..].to_vec();
    let has = |w: &str| args.iter().any(|a| a.trim_matches(['"', '\'']) == w);
    let script = args
        .iter()
        .find(|a| !a.starts_with('-') && **a != "run" && **a != "x" && **a != "exec")
        .map(|a| a.to_lowercase())
        .unwrap_or_default();
    let all = part.to_lowercase();
    if all.contains("bench") {
        return Some("Benchmarking".to_owned());
    }
    let phrase = match program {
        "cd" | "echo" | "export" | "set" | "true" | "printf" | "mkdir" | "source" | "." => {
            return None;
        }
        "vitest" | "jest" | "pytest" | "mocha" | "rspec" | "phpunit" | "ava" | "tap" => {
            "Running the tests"
        }
        "npm" | "bun" | "pnpm" | "yarn" | "deno" | "npx" | "bunx" | "make" | "just" => {
            if script.starts_with("test") || script == "vitest" || script == "jest" {
                "Running the tests"
            } else if script.starts_with("build") || (program == "make" && script.is_empty()) {
                "Building"
            } else if script.starts_with("lint") || script == "oxlint" || script == "eslint" {
                "Checking the code"
            } else if script.starts_with("typecheck") || script == "tsc" {
                "Checking the types"
            } else if script.starts_with("fmt") || script.starts_with("format") {
                "Formatting the code"
            } else if matches!(script.as_str(), "install" | "i" | "ci" | "add") {
                "Installing packages"
            } else if script.starts_with("dev") || script.starts_with("start") {
                "Starting the app"
            } else {
                return None;
            }
        }
        "cargo" | "go" | "swift" | "dotnet" | "mvn" | "gradle" | "mix" => match script.as_str() {
            "test" | "nextest" => "Running the tests",
            "build" | "package" | "compile" => "Building",
            "clippy" | "vet" | "check" => "Checking the code",
            "fmt" => "Formatting the code",
            "add" | "get" | "install" => "Installing packages",
            "run" => "Running the app",
            _ => return None,
        },
        "python" | "python3" | "node" | "ruby" | "tsx" | "ts-node" => {
            if all.contains("-m pytest") || all.contains("unittest") {
                "Running the tests"
            } else if all.contains("-m pip install") {
                "Installing packages"
            } else {
                return args
                    .iter()
                    .find(|a| !a.starts_with('-'))
                    .map(|script| with("Running", Some(file_name(script))));
            }
        }
        "pip" | "pip3" | "uv" | "poetry" | "brew" | "apt" | "apt-get"
            if has("install") || has("add") =>
        {
            "Installing packages"
        }
        "tsc" => "Checking the types",
        "eslint" | "oxlint" | "ruff" | "flake8" => "Checking the code",
        "prettier" | "oxfmt" | "black" | "rustfmt" | "gofmt" => "Formatting the code",
        "grep" | "rg" | "ag" | "ack" | "find" | "fd" => "Searching its files",
        "ls" | "tree" => "Looking through its files",
        "cat" | "head" | "tail" | "less" | "bat" | "nl" | "wc" | "sed" | "awk" | "jq" => {
            return args
                .iter()
                .rev()
                .find(|a| !a.starts_with('-') && a.contains('.') && !a.contains(['{', '\'', '"']))
                .map(|path| with("Reading", Some(file_name(path))))
                .or(Some("Reading a file".to_owned()));
        }
        "curl" | "wget" => {
            return Some(
                match args.iter().find_map(|a| host(a.trim_matches(['"', '\'']))) {
                    Some(host) => with("Fetching", Some(host)),
                    None => "Fetching a page".to_owned(),
                },
            );
        }
        "git" => match script.as_str() {
            "commit" => "Committing",
            "push" => "Pushing",
            "merge" if has("main") || has("origin/main") => "Merging main",
            "merge" => "Merging",
            "pull" | "fetch" => "Pulling changes",
            "clone" => "Cloning a repository",
            "diff" | "status" | "log" | "show" => "Checking the changes",
            _ => return None,
        },
        _ => return None,
    };
    Some(phrase.to_owned())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_newest_bold_headline_in_reasoning_is_the_line() {
        let reasoning =
            "**Reading the brief**\n\nThe person wants...\n\n**Comparing flight prices**\n\nI";
        assert_eq!(
            headline(reasoning).as_deref(),
            Some("Comparing flight prices")
        );
        assert_eq!(
            headline("## Checking the calendar\nmore").as_deref(),
            Some("Checking the calendar")
        );
        // Unclosed, a sentence in bold, or prose: no headline yet.
        assert_eq!(headline("**Comparing flight"), None);
        assert_eq!(headline("I should **really** look at this"), None);
        assert_eq!(headline("Let me think about the flights."), None);
    }

    #[test]
    fn a_long_headline_is_cut_to_a_few_words_and_never_ends_dangling() {
        assert_eq!(
            short("**Analyzing the failing tests in the auth module today**").as_deref(),
            Some("Analyzing the failing tests")
        );
        assert_eq!(short("  `x`  \u{7}  ").as_deref(), Some("X"));
        assert_eq!(short("**  **"), None);
        let long = short(&"supercalifragilistic ".repeat(6)).unwrap_or_default();
        assert!(long.chars().count() <= MAX_CHARS, "{long}");
    }

    #[test]
    fn the_plan_step_in_progress_is_the_first_not_done() {
        let plan = json!({ "items": [
            { "text": "Find flights", "done": true },
            { "text": "Compare **hotel** prices", "done": false },
            { "text": "Book" },
        ] });
        assert_eq!(plan_step(&plan).as_deref(), Some("Compare hotel prices"));
        assert_eq!(
            plan_step(&json!({ "items": [{ "text": "Done", "done": true }] })),
            None
        );
    }

    #[test]
    fn each_tool_reads_as_what_it_does() {
        let cases = [
            (
                "web_search",
                json!({ "query": "flights to Oslo in May" }),
                Some("Searching the web for flights"),
            ),
            ("web_search", json!({}), Some("Searching the web")),
            (
                "web_fetch",
                json!({ "url": "https://www.example.com/a?b" }),
                Some("Reading example.com"),
            ),
            (
                "research",
                json!({ "question": "Which investors fund climate startups?" }),
                Some("Researching investors fund climate startups"),
            ),
            (
                "memory_search",
                json!({ "query": "tea" }),
                Some("Checking its notes"),
            ),
            (
                "workspace_read",
                json!({ "path": "notes/trip.md" }),
                Some("Reading trip.md"),
            ),
            (
                "workspace_edit",
                json!({ "path": "a/b.md" }),
                Some("Editing b.md"),
            ),
            (
                "delegate",
                json!({ "tasks": [{}, {}, {}] }),
                Some("Handing work to 3 ace agents"),
            ),
            (
                "wait",
                json!({ "threadIds": ["t1", "t2", "t3"] }),
                Some("Waiting on 3 ace agents"),
            ),
            (
                "wait",
                json!({ "threadIds": ["t1"] }),
                Some("Waiting on an ace agent"),
            ),
            ("notion__search", json!({}), Some("Searching Notion")),
            (
                "notion__get_pages",
                json!({}),
                Some("Reading your Notion pages"),
            ),
            (
                "notion__create_page",
                json!({}),
                Some("Creating page in Notion"),
            ),
            (
                "google_calendar__list_events",
                json!({}),
                Some("Reading your Google Calendar events"),
            ),
            (
                "call_tool",
                json!({ "name": "slack__send_message", "arguments": {} }),
                Some("Sending message in Slack"),
            ),
            (
                "todo",
                json!({ "items": [{ "text": "Draft the email" }] }),
                Some("Draft the email"),
            ),
            (
                "shell",
                json!({ "command": "cargo test -p core" }),
                Some("Running the tests"),
            ),
            (
                "shell",
                json!({ "command": "ls -la" }),
                Some("Looking through its files"),
            ),
            ("send_email", json!({}), Some("Sending an email")),
            // A tool nothing knows: no phrase, so the line says "Working", never its id.
            ("frobnicate_widgets", json!({}), None),
            ("shell", json!({ "command": "./mystery --flag" }), None),
        ];
        for (name, arguments, expected) in cases {
            assert_eq!(
                tool(name, &arguments).as_deref(),
                expected,
                "{name} {arguments}"
            );
        }
    }

    #[test]
    fn each_sandbox_command_reads_as_what_it_does() {
        let cases = [
            ("bun run test:fast", Some("Running the tests")),
            (
                "cd app && npx vitest run src/a.test.ts",
                Some("Running the tests"),
            ),
            ("CI=1 pytest -q", Some("Running the tests")),
            ("go test ./...", Some("Running the tests")),
            ("python -m pytest", Some("Running the tests")),
            ("cargo bench", Some("Benchmarking")),
            ("bun run bench:startup", Some("Benchmarking")),
            ("cargo build --release", Some("Building")),
            ("npm run build", Some("Building")),
            ("rg -n TODO src", Some("Searching its files")),
            ("grep -r foo . | head", Some("Searching its files")),
            ("cat src/auth.ts", Some("Reading auth.ts")),
            ("sed -n '1,80p' src/auth.ts", Some("Reading auth.ts")),
            ("git commit -m 'x'", Some("Committing")),
            ("git push origin HEAD", Some("Pushing")),
            ("git merge origin/main", Some("Merging main")),
            ("pip install requests", Some("Installing packages")),
            (
                "curl -s https://api.example.com/v1",
                Some("Fetching api.example.com"),
            ),
            ("python3 scrape.py --all", Some("Running scrape.py")),
            ("timeout 60 cargo test", Some("Running the tests")),
            ("echo hi", None),
            ("./run.sh", None),
        ];
        for (line, expected) in cases {
            assert_eq!(command(line).as_deref(), expected, "{line}");
        }
    }

    #[test]
    fn a_phrase_never_carries_a_secret() {
        let phrase = tool(
            "web_search",
            &json!({ "query": "sk-ant-api03-abcdefghijklmnopqrstuvwxyz" }),
        )
        .unwrap_or_default();
        assert!(!phrase.contains("abcdefghij"), "{phrase}");
    }
}
