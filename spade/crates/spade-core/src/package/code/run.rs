//! What Spade decides about running a package's code (ADR 0203 §2, §4, §5), as data: the switch
//! each component has, the names its tools are offered under, the list a component gives of
//! them, the hosts its `http` may reach, the `spade.v1` tools it may call, and the line a call
//! that gave no answer reads as. Pure; running it is the server's and `spade-wasm`'s.

use serde::Deserialize;
use serde_json::Value;

use super::Code;
use crate::effect::runtime::{self, Source};
use crate::package::manifest::Declared;

/// A component's switch key starts with this: `code:fares`. No effect's key does.
pub const SWITCH_PREFIX: &str = "code:";
/// A code tool's name starts with this: `code_fares_cheapest`.
pub const TOOL_PREFIX: &str = "code_";
/// At most this many tools a component gives; the rest are left out.
pub const MOST_TOOLS: usize = 32;
/// A tool's own name, as a component gives it, is at most this long.
pub const TOOL_NAME_CHARS: usize = 32;
/// A tool's summary, for the model, is cut to this.
pub const SUMMARY_CHARS: usize = 500;

/// The switch the person turns a component on or off with, beside the effects' switches.
pub fn switch_key(component: &str) -> String {
    format!("{SWITCH_PREFIX}{component}")
}

/// The component a switch key names, when it is a component's.
pub fn switch_component(key: &str) -> Option<&str> {
    key.strip_prefix(SWITCH_PREFIX)
}

/// The name a component's tool is offered under: `code_<component>_<tool>`.
pub fn tool_name(component: &str, tool: &str) -> String {
    format!("{TOOL_PREFIX}{component}_{tool}")
}

/// Whether `name` is a code tool's.
pub fn is_tool(name: &str) -> bool {
    name.starts_with(TOOL_PREFIX)
}

/// One tool a component gives, as its `toolbox.tools` lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolSpec {
    pub name: String,
    pub summary: String,
    /// Its input's JSON schema, an object schema; `{}` reads as any object.
    pub input_schema: Value,
}

#[derive(Deserialize)]
struct Listed {
    name: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    input_schema: Value,
}

/// The tools a component's `toolbox.tools` answer lists (ADR 0203 §2), read leniently: an entry
/// that doesn't read, or whose name isn't lower-case letters, digits and `_` starting with a
/// letter, is left out with a line saying why, as is a second entry of one name. Unknown fields
/// are ignored. `Err` only when the answer isn't a JSON array at all.
pub fn tools_from(json: &str) -> Result<(Vec<ToolSpec>, Vec<String>), String> {
    let value: Value =
        serde_json::from_str(json).map_err(|_| "its tool list isn't JSON".to_owned())?;
    let Some(items) = value.as_array() else {
        return Err("its tool list isn't a JSON array".to_owned());
    };
    let mut tools: Vec<ToolSpec> = Vec::new();
    let mut left_out = Vec::new();
    for (at, item) in items.iter().enumerate() {
        let Ok(listed) = serde_json::from_value::<Listed>(item.clone()) else {
            left_out.push(format!("tool {at} has no name"));
            continue;
        };
        if !tool_name_ok(&listed.name) {
            left_out.push(format!(
                "{:?}: a tool's name is lower-case letters, digits and _, starting with a letter",
                listed.name
            ));
            continue;
        }
        if tools.iter().any(|t| t.name == listed.name) {
            left_out.push(format!("{} is listed twice", listed.name));
            continue;
        }
        if tools.len() == MOST_TOOLS {
            left_out.push(format!(
                "{} is past the {MOST_TOOLS} tools a component gives",
                listed.name
            ));
            continue;
        }
        let input_schema = match listed.input_schema {
            Value::Object(map) if !map.is_empty() => Value::Object(map),
            _ => serde_json::json!({ "type": "object" }),
        };
        tools.push(ToolSpec {
            name: listed.name,
            summary: listed.summary.chars().take(SUMMARY_CHARS).collect(),
            input_schema,
        });
    }
    Ok((tools, left_out))
}

fn tool_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && name.len() <= TOOL_NAME_CHARS
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// The hosts a component's `http` may reach: those the package declares under `network` whose
/// switch the person left on (`on`). The egress proxy holds the request to the bot's policy too.
pub fn reachable_hosts(effects: &[Declared], on: &impl Fn(&str) -> bool) -> Vec<String> {
    effects
        .iter()
        .filter(|d| d.effect == crate::effect::Effect::Network && on(&d.key()))
        .flat_map(|d| d.hosts.iter().cloned())
        .collect()
}

/// The host a code `http` request to `url` goes to, if it may: https only, to a host `hosts`
/// names (`api.example.com`, or `*.example.com` for its subdomains). Otherwise why not, in a
/// sentence the component reads.
pub fn http_host(url: &str, hosts: &[String]) -> Result<String, String> {
    let Some(rest) = url.strip_prefix("https://") else {
        return Err("code sends only https requests".to_owned());
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') {
        return Err("a request's address carries no user name or password".to_owned());
    }
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => host,
        _ => authority,
    }
    .trim_end_matches('.')
    .to_ascii_lowercase();
    if host.is_empty() {
        return Err("the request names no host".to_owned());
    }
    let allowed = hosts.iter().any(|pattern| {
        let pattern = pattern.to_ascii_lowercase();
        match pattern.strip_prefix("*.") {
            Some(parent) => host.ends_with(&format!(".{parent}")),
            None => host == pattern,
        }
    });
    if allowed {
        Ok(host)
    } else if hosts.is_empty() {
        Err(format!(
            "{host} isn't reachable: the package declares no network hosts the person left on"
        ))
    } else {
        Err(format!(
            "{host} isn't one of the hosts the package declares and the person left on ({})",
            hosts.join(", ")
        ))
    }
}

/// Tools of `spade.v1` code may not call through `spade:package/tools`: the ones the turn
/// answers itself (a question, a connect or suggest card, the goal and plan, tool search), the
/// ones the engine routes on rules of their own (a bot's own task and face, a bot made for the
/// person), and those that launch commands, which are decided on what the command runs.
const BARRED: &[&str] = &[
    crate::context::ASK_USER,
    crate::question::connect::APP_CONNECT_REQUEST,
    crate::question::suggest::PACKAGE_SUGGEST,
    crate::tools::TOOL_SEARCH,
    crate::tools::CALL_TOOL,
    crate::goal::TASK_GOAL,
    crate::goal::TASK_PLAN,
    crate::self_edit::TASK_UPDATE,
    crate::self_edit::PROFILE_UPDATE,
    crate::made::CLUB_ADD,
    crate::tree::BOT_CREATE,
    "shell",
    "service_start",
];

/// Why code may not call `name` through `spade:package/tools`, if it may not: only Spade's own
/// `spade.v1` tools are callable (ADR 0203 §2), not an app's or ace's, not another code tool, and
/// none of [`BARRED`].
pub fn call_refusal(name: &str) -> Option<String> {
    if name.len() > MOST_CALL_NAME {
        return Some(format!(
            "a tool's name is at most {MOST_CALL_NAME} characters; code asked for a longer one"
        ));
    }
    if is_tool(name) {
        return Some(format!("{name}: code doesn't call code tools"));
    }
    match runtime::tool(name) {
        Some(tool) if tool.source == Source::Table && !BARRED.contains(&name) => None,
        Some(_) => Some(format!("{name} can't be called from code")),
        None => Some(format!("{name} isn't a spade.v1 tool code can call")),
    }
}

/// How a code call that gave no answer reads to the bot (ADR 0203 §4): one line, "fares stopped:
/// it ran longer than 30 s."
pub fn stopped_line(code: &Code, why: Stop) -> String {
    let because = match why {
        Stop::Deadline => format!("it ran longer than {} s", code.timeout_s),
        Stop::Fuel => "it ran without yielding for too long".to_owned(),
        Stop::Memory => format!("it needed more than {} MiB of memory", code.memory_mb),
        Stop::Trap => "it failed on its own".to_owned(),
        Stop::Stopped => "it was stopped, so it is not done".to_owned(),
        Stop::Refused => "it couldn't start".to_owned(),
        Stop::Lost => "its worker ended during the call, so what it did is unknown".to_owned(),
    };
    format!("{} stopped: {because}.", code.name)
}

/// Why a code call gave no answer, as [`stopped_line`] says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    Deadline,
    Fuel,
    Memory,
    Trap,
    Stopped,
    Refused,
    Lost,
}

/// Whether moving a component from `old` to `new` asks for more: a component that wasn't there,
/// or one that imports something it didn't. Such a component starts off (ADR 0203 §5).
pub fn asks_more(old: Option<&Code>, new: &Code) -> bool {
    old.is_none_or(|old| new.imports.iter().any(|i| !old.imports.contains(i)))
}

/// What Spade knows about one `tools` call a component makes, for [`route`].
#[derive(Debug, Clone, Copy)]
pub struct CodeCall<'a> {
    pub tool: &'a str,
    pub risk: crate::tools::Risk,
    /// The called tool's effect, as it declares it.
    pub effect: Option<crate::effect::Effect>,
    /// Anything untrusted is in view: the call's input, an `http` answer, a tool's untrusted
    /// result, or the turn's prompt.
    pub tainted: bool,
    pub mode: crate::autonomy::Mode,
    pub ceiling: Option<crate::effect::ceiling::Ceiling<'a>>,
    pub granted: crate::effect::Granted,
    /// A file write a checkpoint taken now can undo.
    pub checkpointed: bool,
    /// Its arguments name a place where sign-ins live.
    pub credentials: bool,
    /// Where a send or push goes, for the request's line.
    pub target: Option<&'a str>,
    /// For a shared bot on an org host, its organization's policy (ADR 0206 §3).
    pub org: Option<crate::org::Gate<'a>>,
    /// The bot's Permissions: a send or a payment its switch leaves off is refused from code too.
    pub permits: crate::permission::Held,
}

/// Where a `tools` call from code goes (ADR 0203 §2): the gate's own route for one of Spade's
/// tools run by Spade, the package's ceiling first and in every mode. Nothing the person answered
/// before carries to code (no Always allow, no kept answer), so a send, a payment or an access
/// change from code is theirs each time; and no reviewer or classifier reads code's calls, so
/// what would go to one goes to the person ([`Route::Ask`]). [`call_refusal`] is checked first.
pub fn route(call: CodeCall<'_>) -> crate::effect::Route {
    use crate::effect::{self, Place, Route};
    let gate = effect::Call {
        tool: call.tool,
        rule: crate::gate::decide(call.risk, false, call.tainted),
        risk: call.risk,
        always: false,
        effect: call.effect,
        remembered: None,
        place: Place::Host,
        tainted: call.tainted,
        credentials: call.credentials,
        standing: crate::autonomy::STANDING.contains(&call.tool),
        fits: true,
        granted: call.granted,
        checkpointed: call.checkpointed,
        target: call.target,
        drive: effect::Drive::default(),
        mode: call.mode,
        remote: false,
        classifier: false,
        ceiling: call.ceiling,
        command: None,
        destructive: false,
        org: call.org,
        permits: call.permits,
        connected: false,
    };
    match effect::route(gate) {
        Route::Review(concern) => Route::Ask {
            line: concern.unwrap_or_else(|| NO_REVIEWER.to_owned()),
            ask: None,
        },
        route => route,
    }
}

/// What Spade knows about one `http` request a component makes, for [`http_route`].
#[derive(Debug, Clone, Copy)]
pub struct HttpCall<'a> {
    /// Anything untrusted is in view: the call's input, an earlier answer, a tool's result.
    pub tainted: bool,
    pub mode: crate::autonomy::Mode,
    /// The package's ceiling as it is now.
    pub ceiling: Option<crate::effect::ceiling::Ceiling<'a>>,
    /// The organization's policy as it is now, for a shared bot (ADR 0206 §3).
    pub org: Option<crate::org::Gate<'a>>,
}

/// The name a request from code is decided and asked about under.
pub const HTTP: &str = "spade:package/http";

/// Where one `http` request from code goes (ADR 0203 §2), read afresh for each request before its
/// egress ticket is issued: the gate's own route for a `network` step Spade makes on the code's
/// behalf. The organization's policy and the package's ceiling come first, as they are now, in
/// every mode. The code tool's own call stands for the step while nothing untrusted is in view;
/// once anything is, each request is the person's, as a write after untrusted content is. On a
/// shared bot every request is its approvers', since an outward step there needs a member's say.
pub fn http_route(call: HttpCall<'_>) -> crate::effect::Route {
    use crate::effect::{self, Effect, Place, Route};
    use crate::tools::Risk;
    let allowed = call.org.is_none();
    let gate = effect::Call {
        tool: HTTP,
        rule: crate::gate::decide(Risk::Write, allowed, call.tainted),
        risk: Risk::Write,
        always: allowed,
        effect: Some(Effect::Network),
        remembered: None,
        place: Place::Host,
        tainted: call.tainted,
        credentials: false,
        standing: false,
        fits: true,
        granted: effect::Granted::No,
        checkpointed: false,
        target: None,
        drive: effect::Drive::default(),
        mode: call.mode,
        remote: false,
        classifier: false,
        ceiling: call.ceiling,
        command: None,
        destructive: false,
        org: call.org,
        // A request from code is a network step: no switch of the bot's covers it.
        permits: crate::permission::Held::default(),
        connected: false,
    };
    match effect::route(gate) {
        Route::Review(concern) => Route::Ask {
            line: concern.unwrap_or_else(|| NO_REVIEWER.to_owned()),
            ask: None,
        },
        route => route,
    }
}

/// The longest tool name code may ask for; a longer one is refused without being kept.
pub const MOST_CALL_NAME: usize = 64;
/// What a call's log of the tools it called keeps: this many lines, this many bytes in all.
pub const MOST_CALL_LINES: usize = 64;
pub const MOST_CALL_BYTES: usize = 4096;

/// The tools a code call asked for and how each ended (`code_ran`'s `calls`), bounded whatever
/// the component sends: a name past [`MOST_CALL_NAME`] is cut, and past [`MOST_CALL_LINES`]
/// lines or [`MOST_CALL_BYTES`] bytes only a count is kept.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallLog {
    lines: Vec<String>,
    bytes: usize,
    more: usize,
}

impl CallLog {
    pub fn push(&mut self, name: &str, outcome: &str) {
        let name: String = name.chars().take(MOST_CALL_NAME).collect();
        let line = format!("{name}: {outcome}");
        if self.lines.len() >= MOST_CALL_LINES || self.bytes + line.len() > MOST_CALL_BYTES {
            self.more += 1;
            return;
        }
        self.bytes += line.len();
        self.lines.push(line);
    }

    /// How many calls it holds or counted.
    pub fn len(&self) -> usize {
        self.lines.len() + self.more
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The lines kept, then how many more there were.
    pub fn lines(&self) -> Vec<String> {
        let mut out = self.lines.clone();
        if self.more > 0 {
            out.push(format!("and {} more", self.more));
        }
        out
    }
}

/// Why the person decides a call code makes that Spade's reviewer would otherwise have read.
pub const NO_REVIEWER: &str = "Spade's reviewer doesn't read the calls code makes, so you decide.";

#[cfg(test)]
mod tests;
