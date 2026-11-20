//! `bot.json`, read (ADR 0200 §3.1–3.7). Version 3 is the agent package's manifest; version 2,
//! ADR 0168's recipe, reads as version 3 with its routines as schedule triggers and nothing else.
//! The matching reader for the market's checks is `readRecipe` in `@ace/marketplace`.
//!
//! What a package may never carry refuses the whole file: anything named or shaped like a secret,
//! an identity field (who published it and which version it is come from the signed manifest),
//! executions (those are plugins'), the `credential` effect, a grant the API never gives a
//! package, and any price but free. Fields this build doesn't know are kept by name as "Not used
//! by this Spade" and can't grant anything: every capability comes from a field read here.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::effect::{self, Effect, runtime};
use crate::grant::{self, Scope};
use crate::personality::Personality;
use crate::routine::{self, AceEvent, Trigger};
use crate::tools::Risk;

pub const FORMAT: &str = "spade-bot";
/// The runtime API's major version this build serves (ADR 0200 §4): `spade.v1`'s.
pub const RUNTIME: &str = runtime::VERSION;

const MOST_TRIGGERS: usize = 40;
const MOST_ROUTINES: usize = 32;
const MOST_NOTES: usize = 50;
const NOTE_CHARS: usize = 2000;
const MOST_TOOLS: usize = 64;
const MOST_EFFECTS: usize = 32;
const MOST_HOSTS: usize = 32;
const MOST_TESTS: usize = 64;
const MOST_REFS: usize = 64;
const WHY_CHARS: usize = 500;

/// Identity is the market's, read from the signed version manifest, never from the file.
const IDENTITY: [&str; 6] = [
    "publisher",
    "signature",
    "signatures",
    "signed",
    "hash",
    "package",
];
/// Runnable executions belong to plugins (ADR 0200 §3.8).
const EXECUTIONS: [&str; 8] = [
    "mcpServers",
    "mcp_servers",
    "mcp",
    "servers",
    "hooks",
    "executions",
    "commands",
    "command",
];
const KNOWN_V3: [&str; 22] = [
    "format",
    "version",
    "requires",
    "name",
    "blurb",
    "task",
    "face",
    "style",
    "personality",
    "model",
    "uses",
    "triggers",
    "skills",
    "plugins",
    "needs",
    "effects",
    "limits",
    "tests",
    "notes",
    "pricing",
    // Read in phase 2 (ADR 0200 §5, §7); kept and listed as not used until then.
    "surfaces",
    "contracts",
];
const NOT_YET: [&str; 2] = ["surfaces", "contracts"];
const KNOWN_V2: [&str; 14] = [
    "personality",
    "format",
    "version",
    "name",
    "blurb",
    "task",
    "face",
    "model",
    "routines",
    "tools",
    "skills",
    "plugins",
    "needs",
    "notes",
];

/// What the reading needs to know about this build.
#[derive(Debug, Clone, Copy)]
pub struct Build<'a> {
    /// Spade's version (`0.0.25`), for `requires.spade`.
    pub version: &'a str,
    /// The longest standing task a bot takes.
    pub task_chars: usize,
}

/// The agent's accent (ADR 0200 §5.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Style {
    pub accent: String,
}

/// What starts its work (ADR 0200 §3.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PackageTrigger {
    Message,
    Mention {
        #[serde(rename = "in")]
        places: Vec<String>,
    },
    Schedule {
        name: String,
        instruction: String,
        schedule: String,
    },
    Event {
        name: String,
        instruction: String,
        event: AceEvent,
    },
    Webhook {
        name: String,
        instruction: String,
    },
}

impl PackageTrigger {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::Mention { .. } => "mention",
            Self::Schedule { .. } => "schedule",
            Self::Event { .. } => "event",
            Self::Webhook { .. } => "webhook",
        }
    }

    /// The routine it becomes (name, instruction, trigger); `None` for one that rides on the
    /// conversation or the `@` picker.
    pub fn routine(&self) -> Option<(&str, &str, Trigger)> {
        match self {
            Self::Message | Self::Mention { .. } => None,
            Self::Schedule {
                name,
                instruction,
                schedule,
            } => Some((
                name,
                instruction,
                Trigger::Schedule {
                    schedule: schedule.clone(),
                },
            )),
            Self::Event {
                name,
                instruction,
                event,
            } => Some((name, instruction, Trigger::Event { event: *event })),
            Self::Webhook { name, instruction } => Some((name, instruction, Trigger::Webhook)),
        }
    }
}

/// One declared effect with its reason: a switch at install, a ceiling after (ADR 0200 §3.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Declared {
    pub effect: Effect,
    /// For `network`: hosts added to the bot's egress allow list while it is on.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hosts: Vec<String>,
    /// A grant its switch makes, of a kind a package may ask for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant: Option<Scope>,
    pub why: String,
}

impl Declared {
    /// The switch's stable key, the same in `@ace/marketplace`: the word, then the hosts or the
    /// grant it asks for (`network:hosts:api.example.com`, `network:drive_site:example.com`).
    pub fn key(&self) -> String {
        let word = self.effect.name();
        if !self.hosts.is_empty() {
            let mut hosts = self.hosts.clone();
            hosts.sort();
            return format!("{word}:hosts:{}", hosts.join(","));
        }
        match &self.grant {
            Some(Scope::DriveSite { host }) => format!("{word}:drive_site:{host}"),
            Some(Scope::DriveApp { app }) => format!("{word}:drive_app:{app}"),
            Some(Scope::Tool { tool, .. }) => format!("{word}:tool:{tool}"),
            Some(_) | None => word.to_owned(),
        }
    }
}

/// What it expects to spend and use: alerts and bounds, never a stop (ADR 0166, 0200 §3.6).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Limits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spend_alert_usd_per_day: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workers_at_once: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_mb: Option<u32>,
}

/// `bot.json`, read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    /// The version the file was written at: 2 installs an unlinked copy, 3 a linked bot.
    pub version: u32,
    pub name: String,
    pub blurb: String,
    pub task: String,
    pub face: Option<Map<String, Value>>,
    pub style: Option<Style>,
    pub personality: Option<Personality>,
    /// `fast` or `capable`, never a model id.
    pub model: String,
    /// Runtime modules it uses; `None` for all of them.
    pub uses: Option<Vec<String>>,
    /// Built-in tools it is narrowed to (`needs.tools`); `None` for all.
    pub tools: Option<Vec<String>>,
    pub triggers: Vec<PackageTrigger>,
    pub skills: Vec<String>,
    pub plugins: Vec<String>,
    /// Apps it names in `needs.connectors`, by catalogue id or https address.
    pub connectors: Vec<String>,
    pub effects: Vec<Declared>,
    pub limits: Limits,
    pub tests: Vec<String>,
    pub notes: Vec<String>,
    /// Fields this build doesn't use, by name, for the review's "Not used by this Spade".
    pub unused: Vec<String>,
}

impl Manifest {
    /// Every declared effect's switch key, in order.
    pub fn effect_keys(&self) -> Vec<String> {
        self.effects.iter().map(Declared::key).collect()
    }

    /// The triggers that become routines, by name.
    pub fn routines(&self) -> impl Iterator<Item = (&str, &str, Trigger)> {
        self.triggers.iter().filter_map(PackageTrigger::routine)
    }
}

/// Reads `bot.json` as a package; every problem that refuses it otherwise.
pub fn read(value: &Value, build: Build<'_>) -> Result<Manifest, Vec<String>> {
    let mut problems = Vec::new();
    secret_problems(value, "bot.json", &mut problems);
    if !problems.is_empty() {
        problems.push("a package never carries a key, token or secret".to_owned());
        return Err(problems);
    }
    let Some(fields) = value.as_object() else {
        return Err(vec!["bot.json isn't an object".to_owned()]);
    };
    if fields.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(vec!["this isn't a Spade bot (format spade-bot)".to_owned()]);
    }
    let version = match fields.get("version") {
        Some(Value::Number(n)) if n.as_u64() == Some(2) => 2,
        Some(Value::Number(n)) if n.as_u64() == Some(3) => 3,
        Some(Value::String(_)) => {
            return Err(vec![
                "version is the format's number; a package's own version comes from the market's signed manifest"
                    .to_owned(),
            ]);
        }
        _ => {
            return Err(vec![
                "this Spade reads bot files of version 2 and 3".to_owned(),
            ]);
        }
    };
    let mut reader = Reader {
        fields,
        problems,
        build,
    };
    let manifest = reader.manifest(version);
    if reader.problems.is_empty() {
        Ok(manifest)
    } else {
        Err(reader.problems)
    }
}

/// Every place in `value` that holds a field named like a secret or a string shaped like one.
pub fn secret_problems(value: &Value, path: &str, out: &mut Vec<String>) {
    match value {
        Value::String(text) if crate::redact::text(text) != *text => {
            out.push(format!("{path} holds something shaped like a secret"));
        }
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                secret_problems(item, &format!("{path}[{i}]"), out);
            }
        }
        Value::Object(fields) => {
            for (key, item) in fields {
                let at = format!("{path}.{key}");
                if crate::redact::secret_name(key) {
                    out.push(format!("{at} is named like a secret"));
                } else {
                    secret_problems(item, &at, out);
                }
            }
        }
        _ => {}
    }
}

struct Reader<'a> {
    fields: &'a Map<String, Value>,
    problems: Vec<String>,
    build: Build<'a>,
}

impl Reader<'_> {
    fn problem(&mut self, text: impl Into<String>) {
        self.problems.push(text.into());
    }

    fn manifest(&mut self, version: u32) -> Manifest {
        for field in IDENTITY {
            if self.fields.contains_key(field) {
                self.problem(format!(
                    "{field}: who published a package and which version it is come from the market's signed manifest, never from bot.json"
                ));
            }
        }
        for field in EXECUTIONS {
            if self.fields.contains_key(field) {
                self.problem(format!(
                    "{field}: a package never carries servers, hooks or commands; name a plugin instead"
                ));
            }
        }
        let known: &[&str] = if version == 3 { &KNOWN_V3 } else { &KNOWN_V2 };
        let unused = self
            .fields
            .keys()
            .filter(|key| {
                NOT_YET.contains(&key.as_str())
                    || !(known.contains(&key.as_str())
                        || IDENTITY.contains(&key.as_str())
                        || EXECUTIONS.contains(&key.as_str()))
            })
            .cloned()
            .collect();
        let name = self.text("name", 80, true);
        let task = self.text("task", self.build.task_chars, false);
        let model = match self.fields.get("model") {
            None => "capable".to_owned(),
            Some(Value::String(m)) if m == "fast" || m == "capable" => m.clone(),
            Some(_) => {
                self.problem("model is fast or capable, never a model of its own");
                String::new()
            }
        };
        let needs = self.fields.get("needs").cloned().unwrap_or(Value::Null);
        let tools = match (version, self.fields.get("tools"), needs.get("tools")) {
            (2, Some(tools), _) | (_, _, Some(tools)) => self.tools(tools),
            _ => None,
        };
        let triggers = if version == 3 {
            self.triggers()
        } else {
            self.routines_v2()
        };
        let manifest = Manifest {
            version,
            name,
            blurb: self.text("blurb", 300, false),
            task,
            face: self.fields.get("face").and_then(Value::as_object).cloned(),
            style: if version == 3 { self.style() } else { None },
            personality: self.personality(),
            model,
            uses: if version == 3 { self.uses() } else { None },
            tools,
            triggers,
            skills: self.refs("skills"),
            plugins: self.refs("plugins"),
            connectors: connectors(&needs),
            effects: if version == 3 {
                self.effects()
            } else {
                Vec::new()
            },
            limits: if version == 3 {
                self.limits()
            } else {
                Limits::default()
            },
            tests: if version == 3 {
                self.tests()
            } else {
                Vec::new()
            },
            notes: self.notes(),
            unused,
        };
        if version == 3 {
            self.requires();
            self.pricing();
        }
        manifest
    }

    fn text(&mut self, field: &str, most: usize, needed: bool) -> String {
        match self.fields.get(field) {
            None | Some(Value::Null) if !needed => String::new(),
            Some(Value::String(text)) if needed && text.trim().is_empty() => {
                self.problem(format!("a package needs a {field}"));
                String::new()
            }
            Some(Value::String(text)) if text.chars().count() > most => {
                self.problem(format!("{field} is at most {most} characters"));
                String::new()
            }
            Some(Value::String(text)) => text.trim().to_owned(),
            _ => {
                self.problem(format!("{field} is text"));
                String::new()
            }
        }
    }

    fn personality(&mut self) -> Option<Personality> {
        let value = self.fields.get("personality")?;
        match serde_json::from_value(value.clone()) {
            Ok(personality) => Some(personality),
            Err(_) => {
                self.problem(
                    "personality is a tone (concise, warm, formal or playful), humour and emoji",
                );
                None
            }
        }
    }

    fn style(&mut self) -> Option<Style> {
        let style = self.fields.get("style")?;
        let accent = style.get("accent").and_then(Value::as_str);
        match accent {
            Some(hex)
                if hex.len() == 7
                    && hex.starts_with('#')
                    && hex[1..].chars().all(|c| c.is_ascii_hexdigit()) =>
            {
                Some(Style {
                    accent: hex.to_ascii_lowercase(),
                })
            }
            _ => {
                self.problem("style.accent is one colour, like #2F7BEA");
                None
            }
        }
    }

    fn tools(&mut self, value: &Value) -> Option<Vec<String>> {
        let named = |t: &str| {
            t.len() <= 64
                && t.starts_with(|c: char| c.is_ascii_lowercase())
                && t.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        };
        let tools: Option<Vec<String>> = value.as_array().and_then(|items| {
            items
                .iter()
                .map(|t| t.as_str().filter(|t| named(t)).map(str::to_owned))
                .collect()
        });
        match tools {
            Some(tools) if tools.len() <= MOST_TOOLS => Some(tools),
            _ => {
                self.problem("needs.tools names built-in tools, at most 64");
                None
            }
        }
    }

    fn uses(&mut self) -> Option<Vec<String>> {
        let items = self.fields.get("uses")?;
        let Some(items) = items.as_array() else {
            self.problem("uses lists runtime modules");
            return None;
        };
        let mut uses = Vec::new();
        for item in items {
            match item.as_str() {
                Some(module) if runtime::Module::parse(module).is_some() => {
                    uses.push(module.to_owned());
                }
                Some(module) => self.problem(format!(
                    "Needs a newer Spade: this one has no {module:?} module"
                )),
                None => self.problem("uses lists runtime modules by name"),
            }
        }
        Some(uses)
    }

    fn routine_text(&mut self, at: &str, item: &Value, field: &str, most: usize) -> String {
        match item.get(field).and_then(Value::as_str).map(str::trim) {
            Some(text) if !text.is_empty() && text.chars().count() <= most => text.to_owned(),
            _ => {
                self.problem(format!("{at}.{field} is text of 1 to {most} characters"));
                String::new()
            }
        }
    }

    fn schedule(&mut self, at: &str, name: &str, schedule: Option<&str>) -> String {
        let schedule = schedule.unwrap_or_default().trim().to_owned();
        let read = Trigger::Schedule {
            schedule: schedule.clone(),
        };
        if !read.schedule().is_ok_and(|s| s.is_some()) {
            self.problem(format!(
                "{at}: the routine {name:?} has a schedule Spade doesn't read"
            ));
        }
        schedule
    }

    fn routines_v2(&mut self) -> Vec<PackageTrigger> {
        let items = match self.fields.get("routines") {
            None => return Vec::new(),
            Some(Value::Array(items)) => items.clone(),
            Some(_) => {
                self.problem("routines is a list");
                return Vec::new();
            }
        };
        let mut triggers = Vec::new();
        for (i, item) in items.iter().enumerate() {
            let at = format!("routines[{i}]");
            let name = self.routine_text(&at, item, "name", routine::NAME_CHARS);
            let instruction =
                self.routine_text(&at, item, "instruction", routine::INSTRUCTION_CHARS);
            let schedule = self.schedule(&at, &name, item.get("schedule").and_then(Value::as_str));
            triggers.push(PackageTrigger::Schedule {
                name,
                instruction,
                schedule,
            });
        }
        self.bounded_routines(&triggers);
        triggers
    }

    fn triggers(&mut self) -> Vec<PackageTrigger> {
        let items = match self.fields.get("triggers") {
            None => return vec![PackageTrigger::Message],
            Some(Value::Array(items)) if items.len() <= MOST_TRIGGERS => items.clone(),
            Some(_) => {
                self.problem(format!("triggers is a list of at most {MOST_TRIGGERS}"));
                return Vec::new();
            }
        };
        let mut triggers = Vec::new();
        for (i, item) in items.iter().enumerate() {
            let at = format!("triggers[{i}]");
            let kind = item.get("kind").and_then(Value::as_str).unwrap_or_default();
            let trigger = match kind {
                "message" => PackageTrigger::Message,
                "mention" => {
                    let places = item
                        .get("in")
                        .and_then(Value::as_array)
                        .map(|p| {
                            p.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_else(|| vec!["threads".to_owned(), "clubs".to_owned()]);
                    if places
                        .iter()
                        .any(|p: &String| p != "threads" && p != "clubs")
                    {
                        self.problem(format!("{at}.in names threads, clubs or both"));
                    }
                    PackageTrigger::Mention { places }
                }
                "schedule" | "event" | "webhook" => {
                    let name = self.routine_text(&at, item, "name", routine::NAME_CHARS);
                    let instruction =
                        self.routine_text(&at, item, "instruction", routine::INSTRUCTION_CHARS);
                    match kind {
                        "schedule" => {
                            let schedule = self.schedule(
                                &at,
                                &name,
                                item.get("schedule").and_then(Value::as_str),
                            );
                            PackageTrigger::Schedule {
                                name,
                                instruction,
                                schedule,
                            }
                        }
                        "event" => {
                            let event = match item.get("event").and_then(Value::as_str) {
                                Some("thread.finished") => AceEvent::ThreadDone,
                                Some("thread.failed") => AceEvent::ThreadFailed,
                                Some("thread.needs_you") => AceEvent::ThreadNeedsYou,
                                _ => {
                                    self.problem(format!(
                                        "{at}.event is thread.finished, thread.failed or thread.needs_you"
                                    ));
                                    AceEvent::ThreadDone
                                }
                            };
                            PackageTrigger::Event {
                                name,
                                instruction,
                                event,
                            }
                        }
                        _ => PackageTrigger::Webhook { name, instruction },
                    }
                }
                // Contract calls (phase 2) and kinds a later build adds: kept, not used.
                _ => continue,
            };
            triggers.push(trigger);
        }
        self.bounded_routines(&triggers);
        triggers
    }

    /// At most 32 routines, each name once: an update finds a routine by its name.
    fn bounded_routines(&mut self, triggers: &[PackageTrigger]) {
        let names: Vec<&str> = triggers
            .iter()
            .filter_map(PackageTrigger::routine)
            .map(|(name, _, _)| name)
            .collect();
        if names.len() > MOST_ROUTINES {
            self.problem(format!("a package has at most {MOST_ROUTINES} routines"));
        }
        let unique: BTreeSet<&str> = names.iter().copied().collect();
        if unique.len() != names.len() {
            self.problem("each routine has a name of its own");
        }
    }

    fn refs(&mut self, field: &str) -> Vec<String> {
        match self.fields.get(field) {
            None => Vec::new(),
            Some(Value::Array(items)) if items.len() <= MOST_REFS => items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            Some(_) => {
                self.problem(format!("{field} is a list of at most {MOST_REFS}"));
                Vec::new()
            }
        }
    }

    fn notes(&mut self) -> Vec<String> {
        let notes = self.refs("notes");
        if notes.len() > MOST_NOTES || notes.iter().any(|n| n.chars().count() > NOTE_CHARS) {
            self.problem(format!(
                "a package has at most {MOST_NOTES} notes of {NOTE_CHARS} characters"
            ));
        }
        notes
    }

    fn tests(&mut self) -> Vec<String> {
        let tests = self.refs("tests");
        let named = |t: &String| {
            t.strip_prefix("tests/")
                .and_then(|rest| rest.strip_suffix(".json"))
                .is_some_and(|stem| {
                    !stem.is_empty()
                        && stem
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                })
        };
        if tests.len() > MOST_TESTS || !tests.iter().all(named) {
            self.problem("tests name files tests/<name>.json in the package");
        }
        tests
    }

    fn effects(&mut self) -> Vec<Declared> {
        let items = match self.fields.get("effects") {
            None => return Vec::new(),
            Some(Value::Array(items)) if items.len() <= MOST_EFFECTS => items.clone(),
            Some(_) => {
                self.problem(format!("effects is a list of at most {MOST_EFFECTS}"));
                return Vec::new();
            }
        };
        let mut declared: Vec<Declared> = Vec::new();
        for (i, item) in items.iter().enumerate() {
            if let Some(one) = self.declared(&format!("effects[{i}]"), item) {
                if declared.iter().any(|d| d.key() == one.key()) {
                    self.problem(format!("effects[{i}] is declared twice"));
                }
                declared.push(one);
            }
        }
        declared
    }

    fn declared(&mut self, at: &str, item: &Value) -> Option<Declared> {
        let word = item
            .get("effect")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let effect = match Effect::parse(word) {
            // Every bot has these inside its sandbox: declaring them changes nothing.
            Some(Effect::Read | Effect::WriteLocal) => return None,
            Some(Effect::Credential) => {
                self.problem(format!(
                    "{at}: credential can't be declared; Spade never hands a bot a secret"
                ));
                return None;
            }
            Some(Effect::Drive) => {
                self.problem(format!(
                    "{at}: driving a page or app is declared as network with a drive_app or drive_site grant"
                ));
                return None;
            }
            Some(e) if effect::ceiling::DECLARABLE.contains(&e) => e,
            _ => {
                self.problem(format!(
                    "{at}: {word:?} isn't an effect; use network, publish, send_as_person, pay or change_access"
                ));
                return None;
            }
        };
        let why = item.get("why").and_then(Value::as_str).map(str::trim);
        let why = match why {
            Some(why) if !why.is_empty() && why.chars().count() <= WHY_CHARS => why.to_owned(),
            _ => {
                self.problem(format!("{at}.why says in a sentence why it needs this"));
                String::new()
            }
        };
        let hosts = self.hosts(at, effect, item.get("hosts"));
        let grant = item.get("grant").and_then(|g| self.grant(at, effect, g));
        if !hosts.is_empty() && grant.is_some() {
            self.problem(format!("{at} asks for hosts or a grant, not both"));
        }
        Some(Declared {
            effect,
            hosts,
            grant,
            why,
        })
    }

    fn hosts(&mut self, at: &str, effect: Effect, value: Option<&Value>) -> Vec<String> {
        let Some(value) = value else {
            return Vec::new();
        };
        if effect != Effect::Network {
            self.problem(format!("{at}: only network names hosts"));
            return Vec::new();
        }
        let hosts: Option<Vec<String>> = value.as_array().and_then(|items| {
            items
                .iter()
                .map(|h| h.as_str().filter(|h| host(h)).map(str::to_ascii_lowercase))
                .collect()
        });
        match hosts {
            Some(hosts) if !hosts.is_empty() && hosts.len() <= MOST_HOSTS => hosts,
            _ => {
                self.problem(format!(
                    "{at}.hosts names 1 to {MOST_HOSTS} hosts, like api.example.com or *.example.com"
                ));
                Vec::new()
            }
        }
    }

    /// A grant a package may ask for: driving one site or app, or one tool that declares what
    /// it does and is never a send or a payment. A push, a comment, a folder, a payment, a send,
    /// an access change, a sensitive place or a device is the person's alone.
    fn grant(&mut self, at: &str, effect: Effect, value: &Value) -> Option<Scope> {
        if !matches!(effect, Effect::Network | Effect::Publish) {
            self.problem(format!(
                "{at}: {} is never granted; it goes to you every time",
                effect.name()
            ));
            return None;
        }
        let Ok(scope) = serde_json::from_value::<Scope>(value.clone()) else {
            self.problem(format!(
                "{at}.grant is a drive_site, drive_app or tool grant"
            ));
            return None;
        };
        if matches!(
            scope,
            Scope::GitPush { .. } | Scope::PrComment { .. } | Scope::Folder { .. }
        ) {
            self.problem(format!(
                "{at}: a package can't ask for a push, a comment or a folder; those are yours to give"
            ));
            return None;
        }
        // A built-in tool that sends or pays is never granted; an app's tool is checked again,
        // by what it declares, when the switch makes the grant.
        let never = |tool: &str| {
            effect::builtin(tool, Risk::Write).and_then(|e| effect::never_granted(Some(e)))
        };
        if let Err(why) = grant::check(&scope, &never) {
            self.problem(format!("{at}: {why}"));
            return None;
        }
        Some(scope)
    }

    fn limits(&mut self) -> Limits {
        let Some(limits) = self.fields.get("limits") else {
            return Limits::default();
        };
        let mut read = Limits::default();
        if let Some(alert) = limits.get("spend_alert") {
            match alert.get("usd_per_day").and_then(Value::as_f64) {
                Some(usd) if (0.0..=10_000.0).contains(&usd) => {
                    read.spend_alert_usd_per_day = Some(usd);
                }
                _ => self.problem("limits.spend_alert.usd_per_day is a number of dollars"),
            }
        }
        let count = |name: &str, most: u64| -> Option<Result<u32, String>> {
            let value = limits.get(name)?;
            Some(
                value
                    .as_u64()
                    .filter(|n| (1..=most).contains(n))
                    .and_then(|n| u32::try_from(n).ok())
                    .ok_or_else(|| format!("limits.{name} is a whole number from 1 to {most}")),
            )
        };
        match count("workers_at_once", 64) {
            Some(Ok(n)) => read.workers_at_once = Some(n),
            Some(Err(why)) => self.problem(why),
            None => {}
        }
        match count("workspace_mb", 1_000_000) {
            Some(Ok(n)) => read.workspace_mb = Some(n),
            Some(Err(why)) => self.problem(why),
            None => {}
        }
        read
    }

    fn requires(&mut self) {
        let Some(requires) = self.fields.get("requires") else {
            return;
        };
        // A string, as the marketplace's reader has it: `"1"`, never `1`.
        let runtime = match requires.get("runtime") {
            None => None,
            Some(Value::String(r)) => Some(r.clone()),
            Some(_) => {
                self.problem(format!("requires.runtime is a string, like \"{RUNTIME}\""));
                None
            }
        };
        if let Some(runtime) = runtime
            && runtime != RUNTIME
        {
            self.problem(format!(
                "Needs a newer Spade: it asks for runtime {runtime:?}, and this one serves {RUNTIME}"
            ));
        }
        if let Some(spade) = requires.get("spade").and_then(Value::as_str)
            && newer(spade, self.build.version)
        {
            self.problem(format!("Needs a newer Spade: {spade} or later"));
        }
    }

    fn pricing(&mut self) {
        let kind = self
            .fields
            .get("pricing")
            .map(|p| p.get("kind").and_then(Value::as_str).unwrap_or_default());
        if kind.is_some_and(|kind| kind != "free") {
            self.problem("Paid packages aren't offered yet.");
        }
    }
}

fn connectors(needs: &Value) -> Vec<String> {
    needs
        .get("connectors")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|c| c.get("id").or_else(|| c.get("url")))
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// `host`, `*.host`, either with `:port`.
fn host(text: &str) -> bool {
    let (name, port) = match text.rsplit_once(':') {
        Some((name, port)) => (name, Some(port)),
        None => (text, None),
    };
    if port.is_some_and(|p| p.parse::<u16>().map_or(true, |p| p == 0)) {
        return false;
    }
    let name = name.strip_prefix("*.").unwrap_or(name);
    name.len() <= 253
        && name.contains('.')
        && name.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
}

/// Whether dotted version `wanted` is newer than `have` (`0.0.30` over `0.0.25`).
pub fn newer(wanted: &str, have: &str) -> bool {
    let parts = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v')
            .split(['.', '-', '+'])
            .map_while(|p| p.parse().ok())
            .collect()
    };
    parts(wanted) > parts(have)
}
