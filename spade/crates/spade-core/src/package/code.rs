//! A package's own code (ADR 0203): the WebAssembly components it names under `code` in
//! `bot.json`, read and checked. Pure. A component is built for Spade's world,
//! `spade:package@1.0.0` (`spade/spec/code/package.wit`), and may import only what that world
//! offers and its entry lists; [`binary`] reads what the bytes really import and export, so the
//! review shows the binary's list, never the manifest's. Running it is `spade-wasm`'s.
//!
//! Each refusal names its rule (`spade_core::rule`, part `code`).
//!
//! The matching reader for the market's checks is `codeProblems` in `@ace/marketplace`; the
//! conformance suite's `code` part (`spade/spec/conformance/code/`) holds both to the same
//! manifest rules, and `spade/spec/code.md` is the part.

pub mod binary;
pub mod run;

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::manifest::Declared;
use crate::effect::Effect;
use crate::rule::{self, Problem};

pub use binary::{Inspected, inspect};

/// At most this many components in a package.
pub const MOST_COMPONENTS: usize = 4;
/// A component's largest size, in bytes: 8 MiB.
pub const MOST_BYTES: usize = 8 * 1024 * 1024;
/// A call's deadline when the entry names none, and the longest it may name.
pub const DEFAULT_TIMEOUT_S: u32 = 30;
pub const MOST_TIMEOUT_S: u32 = 300;
/// An instance's linear memory when the entry names none, and the most it may name.
pub const DEFAULT_MEMORY_MB: u32 = 128;
pub const MOST_MEMORY_MB: u32 = 512;
/// Fuel per call, a guard against a tight loop that never yields (ADR 0203 §4).
pub const FUEL_PER_CALL: u64 = 10_000_000_000;
/// Tables per instance.
pub const MOST_TABLES: u32 = 16;

/// The world a component of this build is built for: it exports `toolbox`.
pub const WORLD: &str = "spade:package/bot-tools@1.0.0";
/// Worlds Spade's interface defines that this build doesn't run yet (ADR 0203 §7, phases 2–3).
pub const LATER_WORLDS: [&str; 3] = [
    "spade:package/bot-contracts@1.0.0",
    "spade:package/bot-checks@1.0.0",
    "spade:package/bot-cards@1.0.0",
];
/// The export a `bot-tools` component must have, by interface (any `1.0.x`).
pub const TOOLBOX: &str = "spade:package/toolbox";

pub const WHY_CHARS: usize = 500;
pub const NAME_CHARS: usize = 24;

/// What a component may import (ADR 0203 §2), by the name a manifest lists it under.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(into = "String", try_from = "String")]
pub enum Import {
    /// Calls a `spade.v1` tool as the bot, through the gate.
    Tools,
    /// One https request through the bot's egress proxy.
    Http,
    /// Lines for the developer, kept with the call.
    Log,
    /// The package's small store on this bot.
    Kv,
    WallClock,
    MonotonicClock,
    Random,
}

impl Import {
    pub const ALL: [Import; 7] = [
        Self::Tools,
        Self::Http,
        Self::Log,
        Self::Kv,
        Self::WallClock,
        Self::MonotonicClock,
        Self::Random,
    ];

    /// The name a manifest lists it under.
    pub fn name(self) -> &'static str {
        match self {
            Self::Tools => "spade:package/tools",
            Self::Http => "spade:package/http",
            Self::Log => "spade:package/log",
            Self::Kv => "spade:package/kv",
            Self::WallClock => "wasi:clocks/wall-clock@0.2",
            Self::MonotonicClock => "wasi:clocks/monotonic-clock@0.2",
            Self::Random => "wasi:random/random@0.2",
        }
    }

    /// One of a manifest's `imports`.
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|i| i.name() == name)
    }

    /// The effect it carries for the gate (ADR 0203 §2): `tools` carries the called tool's, read
    /// at run time, so it has none of its own here.
    pub fn effect(self) -> Option<Effect> {
        match self {
            Self::Http => Some(Effect::Network),
            Self::Kv => Some(Effect::WriteLocal),
            _ => None,
        }
    }
}

impl From<Import> for String {
    fn from(import: Import) -> Self {
        import.name().to_owned()
    }
}

impl TryFrom<String> for Import {
    type Error = String;
    fn try_from(name: String) -> Result<Self, String> {
        Self::parse(&name).ok_or_else(|| outside(&name))
    }
}

/// Why an import outside Spade's world is refused, in a sentence.
pub fn outside(name: &str) -> String {
    let base = name.split('@').next().unwrap_or(name);
    if base.starts_with("wasi:filesystem") || base.starts_with("wasi:sockets") {
        format!(
            "{name}: code has no file system or sockets; files come through spade:package/tools, under the gate"
        )
    } else if base.starts_with("wasi:cli") {
        format!("{name}: code has no environment, arguments or standard streams")
    } else if base.starts_with("wasi:http") {
        format!("{name}: code makes requests only with spade:package/http, through Spade")
    } else if base.contains("thread") {
        format!("{name}: code runs without threads")
    } else {
        format!("{name} is outside Spade's world (spade:package@1.0.0)")
    }
}

/// One component a package ships, as `bot.json` names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Code {
    pub name: String,
    /// `code/<name>.wasm`.
    pub file: String,
    pub world: String,
    /// What it says it imports; [`check`] holds the binary to exactly this.
    pub imports: Vec<Import>,
    pub why: String,
    /// A call's deadline, in seconds of running (time waiting on Spade doesn't count).
    pub timeout_s: u32,
    /// An instance's linear memory, in MiB.
    pub memory_mb: u32,
}

impl Code {
    /// The strongest effect among its imports (ADR 0203 §2): `network` with `http`, else
    /// `write_local` with `kv`, else `read`. A `tools` call's own effect is the called tool's,
    /// gated at run time.
    pub fn effect(&self) -> Effect {
        if self.imports.contains(&Import::Http) {
            Effect::Network
        } else if self.imports.contains(&Import::Kv) {
            Effect::WriteLocal
        } else {
            Effect::Read
        }
    }

    /// The bounds of one call (ADR 0203 §4).
    pub fn bounds(&self) -> Bounds {
        Bounds {
            deadline_ms: u64::from(self.timeout_s) * 1000,
            fuel: FUEL_PER_CALL,
            memory_bytes: u64::from(self.memory_mb) * 1024 * 1024,
        }
    }
}

/// What one code call may use: the same kind of bound as any tool call's, never one on the task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bounds {
    /// Wall clock while the component runs; waits on Spade are not counted.
    pub deadline_ms: u64,
    pub fuel: u64,
    /// Linear memory of the call's one instance.
    pub memory_bytes: u64,
}

/// Reads `bot.json`'s `code`, with every problem in `problems`. `effects` are the package's
/// declared effects: `http` needs a `network` effect that names hosts.
pub fn read(value: Option<&Value>, effects: &[Declared], problems: &mut Vec<Problem>) -> Vec<Code> {
    let items = match value {
        None => return Vec::new(),
        Some(Value::Array(items)) if items.len() <= MOST_COMPONENTS => items,
        Some(_) => {
            problems.push(Problem::new(
                rule::CODE_LIST,
                format!("code is a list of at most {MOST_COMPONENTS} components"),
            ));
            return Vec::new();
        }
    };
    let mut out: Vec<Code> = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let at = format!("code[{i}]");
        if let Some(code) = entry(&at, item, effects, problems) {
            if out.iter().any(|c| c.name == code.name) {
                problems.push(Problem::new(
                    rule::CODE_NAME_UNIQUE,
                    format!("{at}: each component has a name of its own"),
                ));
            }
            out.push(code);
        }
    }
    out
}

fn entry(
    at: &str,
    item: &Value,
    effects: &[Declared],
    problems: &mut Vec<Problem>,
) -> Option<Code> {
    let Some(fields) = item.as_object() else {
        problems.push(Problem::new(rule::CODE_FIELD, format!("{at} is an object")));
        return None;
    };
    let before = problems.len();
    let name = fields
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let named = !name.is_empty()
        && name.len() <= NAME_CHARS
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    if !named {
        problems.push(Problem::new(
            rule::CODE_NAME,
            format!(
                "{at}.name is 1 to {NAME_CHARS} lower-case letters and digits, starting with a letter"
            ),
        ));
    }
    let file = fields
        .get("file")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if file != format!("code/{name}.wasm") {
        problems.push(Problem::new(
            rule::CODE_FILE,
            format!("{at}.file is code/{name}.wasm: a component, never precompiled code (.cwasm)"),
        ));
    }
    let world = fields
        .get("world")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if LATER_WORLDS.contains(&world) {
        problems.push(Problem::new(
            rule::CODE_WORLD_LATER,
            format!("Needs a newer Spade: this one runs code built for {WORLD} only, not {world}"),
        ));
    } else if world != WORLD {
        problems.push(Problem::new(
            rule::CODE_WORLD,
            format!("{at}.world is {WORLD}"),
        ));
    }
    let imports = imports(at, fields.get("imports"), problems);
    if imports.contains(&Import::Http) && !effects.iter().any(reaches_hosts) {
        problems.push(Problem::new(
            rule::CODE_HTTP_NETWORK,
            format!(
                "{at} imports spade:package/http, which needs a declared network effect naming its hosts"
            ),
        ));
    }
    let why = fields.get("why").and_then(Value::as_str).map(str::trim);
    let why = match why {
        Some(why) if !why.is_empty() && why.chars().count() <= WHY_CHARS => why.to_owned(),
        _ => {
            problems.push(Problem::new(
                rule::CODE_WHY,
                format!("{at}.why says in a sentence what its code does"),
            ));
            String::new()
        }
    };
    let timeout_s = bound(
        at,
        fields.get("timeout_s"),
        "timeout_s",
        DEFAULT_TIMEOUT_S,
        MOST_TIMEOUT_S,
        problems,
    );
    let memory_mb = bound(
        at,
        fields.get("memory_mb"),
        "memory_mb",
        DEFAULT_MEMORY_MB,
        MOST_MEMORY_MB,
        problems,
    );
    (problems.len() == before).then(|| Code {
        name: name.to_owned(),
        file: file.to_owned(),
        world: world.to_owned(),
        imports,
        why,
        timeout_s,
        memory_mb,
    })
}

fn reaches_hosts(declared: &Declared) -> bool {
    declared.effect == Effect::Network && !declared.hosts.is_empty()
}

fn imports(at: &str, value: Option<&Value>, problems: &mut Vec<Problem>) -> Vec<Import> {
    let Some(items) = value.and_then(Value::as_array) else {
        problems.push(Problem::new(
            rule::CODE_IMPORTS,
            format!("{at}.imports lists what the component imports, [] for nothing"),
        ));
        return Vec::new();
    };
    let mut out = BTreeSet::new();
    for item in items {
        match item.as_str() {
            Some(name) => match Import::parse(name) {
                Some(import) => {
                    if !out.insert(import) {
                        problems.push(Problem::new(
                            rule::CODE_IMPORT_TWICE,
                            format!("{at}.imports lists {name} twice"),
                        ));
                    }
                }
                None => problems.push(Problem::new(
                    rule::CODE_IMPORT,
                    format!("{at}: {}", outside(name)),
                )),
            },
            None => problems.push(Problem::new(
                rule::CODE_IMPORTS,
                format!("{at}.imports names interfaces"),
            )),
        }
    }
    out.into_iter().collect()
}

fn bound(
    at: &str,
    value: Option<&Value>,
    field: &str,
    default: u32,
    most: u32,
    problems: &mut Vec<Problem>,
) -> u32 {
    let Some(value) = value else {
        return default;
    };
    match value.as_u64().and_then(|n| u32::try_from(n).ok()) {
        Some(n) if (1..=most).contains(&n) => n,
        _ => {
            problems.push(Problem::new(
                rule::CODE_BOUND,
                format!("{at}.{field} is a whole number from 1 to {most}"),
            ));
            default
        }
    }
}

/// `bytes` as `code`'s component: what they import and export, or why they're refused. The
/// binary's imports must be exactly the entry's, and it must export the world's interface.
pub fn check(code: &Code, bytes: &[u8]) -> Result<Inspected, Vec<Problem>> {
    let inspected = inspect(&code.file, bytes)?;
    let mut problems = Vec::new();
    let listed: BTreeSet<Import> = code.imports.iter().copied().collect();
    let found: BTreeSet<Import> = inspected.imports.iter().copied().collect();
    if listed != found {
        let names = |set: &BTreeSet<Import>| {
            let names: Vec<&str> = set.iter().map(|i| i.name()).collect();
            if names.is_empty() {
                "nothing".to_owned()
            } else {
                names.join(", ")
            }
        };
        problems.push(Problem::new(
            rule::CODE_BINARY_IMPORTS,
            format!(
                "{} imports {}, but bot.json lists {}; the two must be the same",
                code.file,
                names(&found),
                names(&listed)
            ),
        ));
    }
    if !inspected.exports.iter().any(|e| e == TOOLBOX) {
        problems.push(Problem::new(
            rule::CODE_BINARY,
            format!(
                "{} doesn't export {TOOLBOX}, which {WORLD} needs",
                code.file
            ),
        ));
    }
    if problems.is_empty() {
        Ok(inspected)
    } else {
        Err(problems)
    }
}

/// Every component `codes` names, read from `file` (path to bytes) and checked; the first
/// problem of each, or what each holds. Files under `code/` the manifest doesn't name are
/// refused by the package's own file rules.
pub fn check_all(
    codes: &[Code],
    file: impl Fn(&str) -> Option<Vec<u8>>,
) -> Result<Vec<Inspected>, Vec<Problem>> {
    let mut problems = Vec::new();
    let mut out = Vec::new();
    for code in codes {
        match file(&code.file) {
            None => problems.push(Problem::new(
                rule::CODE_FILE_MISSING,
                format!("{} is named in code but isn't in the package", code.file),
            )),
            Some(bytes) => match check(code, &bytes) {
                Ok(inspected) => out.push(inspected),
                Err(found) => problems.extend(found),
            },
        }
    }
    if problems.is_empty() {
        Ok(out)
    } else {
        Err(problems)
    }
}

/// The install review's row for one component (ADR 0203 §5), from what its binary imports and
/// the hosts the package declares: "Runs its own code: fares. It can call Spade's tools as this
/// bot."
pub fn review_row(code: &Code, inspected: &Inspected, effects: &[Declared]) -> String {
    let mut can = Vec::new();
    if inspected.imports.contains(&Import::Http) {
        let hosts: Vec<&str> = effects
            .iter()
            .filter(|d| reaches_hosts(d))
            .flat_map(|d| d.hosts.iter().map(String::as_str))
            .collect();
        can.push(format!("reach {}", hosts.join(", ")));
    }
    if inspected.imports.contains(&Import::Tools) {
        can.push("call Spade's tools as this bot".to_owned());
    }
    if inspected.imports.contains(&Import::Kv) {
        can.push("keep a small store on this bot".to_owned());
    }
    let reach = match can.len() {
        0 => "It reaches nothing outside itself.".to_owned(),
        1 => format!("It can {}.", can[0]),
        _ => {
            let last = can.pop().unwrap_or_default();
            format!("It can {} and {last}.", can.join(", "))
        }
    };
    format!("Runs its own code: {}. {reach}", code.name)
}
