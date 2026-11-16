//! What a call does, declared once per tool, and where that sends it (ADR 0171;
//! spade/docs/autonomy.md). Spade decides on effects, not words: a command the sandbox holds runs,
//! a payment or a send in the person's name goes to them, a write outside the box with no grant is
//! reviewed, and a tool that says nothing about itself asks the person once. Tool names and
//! descriptions are never read for words here. Pure: the engine brings the facts.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::autonomy::{self, Class};
use crate::gate::Decision;
use crate::tools::Risk;

/// What a tool does, from least to most serious (the order a set of declarations is read in).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    /// Only reads.
    Read,
    /// Changes only the bot's own things: its folder, notes, plan, routines, workers.
    WriteLocal,
    /// Changes something outside the bot: an app's data, another bot, an ace thread.
    Network,
    /// Publishes: a release, a package, a deploy, a merge.
    Publish,
    /// Sends something in the person's name: a message, a mail, a comment, a push.
    SendAsPerson,
    /// Spends money.
    Pay,
    /// Changes sign-ins, keys or who has access.
    ChangeAccess,
    /// Hands back a secret.
    Credential,
}

impl Effect {
    pub const ALL: [Self; 8] = [
        Self::Read,
        Self::WriteLocal,
        Self::Network,
        Self::Publish,
        Self::SendAsPerson,
        Self::Pay,
        Self::ChangeAccess,
        Self::Credential,
    ];

    /// The word a declaration uses.
    pub fn name(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::WriteLocal => "write_local",
            Self::Network => "network",
            Self::Publish => "publish",
            Self::SendAsPerson => "send_as_person",
            Self::Pay => "pay",
            Self::ChangeAccess => "change_access",
            Self::Credential => "credential",
        }
    }

    /// A declared word; `None` for one this build doesn't know, which declares nothing.
    pub fn parse(word: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|e| e.name() == word.trim())
    }

    /// The most serious of what a value declares: one word, or a list of them. Unknown words are
    /// dropped; `None` when nothing it says is an effect.
    pub fn declared(value: &Value) -> Option<Self> {
        match value {
            Value::String(word) => Self::parse(word),
            Value::Array(words) => words.iter().filter_map(Self::declared).max(),
            _ => None,
        }
    }
}

/// Spade's own tools and what each does. A tool missing here is read by its risk (a read is a
/// read, a note is a local write) and otherwise asks the person once.
const BUILTIN: &[(&str, Effect)] = &[
    ("workspace_list", Effect::Read),
    ("workspace_read", Effect::Read),
    ("workspace_search", Effect::Read),
    ("workspace_write", Effect::WriteLocal),
    ("workspace_edit", Effect::WriteLocal),
    ("shell", Effect::WriteLocal),
    ("service_start", Effect::WriteLocal),
    ("service_status", Effect::Read),
    ("service_logs", Effect::Read),
    ("service_stop", Effect::WriteLocal),
    ("memory_save", Effect::WriteLocal),
    ("memory_update", Effect::WriteLocal),
    ("memory_forget", Effect::WriteLocal),
    ("memory_search", Effect::Read),
    ("history_read", Effect::Read),
    ("history_search", Effect::Read),
    ("about_person", Effect::Read),
    ("knowledge_write", Effect::WriteLocal),
    ("knowledge_update", Effect::WriteLocal),
    ("knowledge_forget", Effect::WriteLocal),
    ("knowledge_link", Effect::WriteLocal),
    ("knowledge_merge", Effect::WriteLocal),
    ("knowledge_read", Effect::Read),
    ("knowledge_search", Effect::Read),
    ("episode_search", Effect::Read),
    ("todo", Effect::WriteLocal),
    (crate::task::TASK_STATUS, Effect::WriteLocal),
    (crate::goal::TASK_GOAL, Effect::WriteLocal),
    (crate::goal::TASK_PLAN, Effect::WriteLocal),
    (crate::decision::DECISION_LOG, Effect::WriteLocal),
    ("skill_search", Effect::Read),
    ("skill_load", Effect::Read),
    ("skill_propose", Effect::WriteLocal),
    ("skill_feedback", Effect::WriteLocal),
    ("routines_list", Effect::Read),
    ("routine_save", Effect::WriteLocal),
    ("routine_delete", Effect::WriteLocal),
    ("image_generate", Effect::WriteLocal),
    ("share_file", Effect::WriteLocal),
    (crate::wake::SLEEP_UNTIL, Effect::WriteLocal),
    (crate::wake::WAIT_FOR, Effect::WriteLocal),
    (crate::wake::WAKE_CANCEL, Effect::WriteLocal),
    (crate::helper::TOOL, Effect::WriteLocal),
    // A worker is another bot that acts on its own: reaching one is reviewed, like bot_message.
    (crate::tree::BOT_CREATE, Effect::Network),
    (crate::tree::WORKER_MESSAGE, Effect::Network),
    (crate::tree::WORKER_STATUS, Effect::Read),
    (crate::tree::WORKER_RESULT, Effect::Read),
    (crate::tree::WORKER_STOP, Effect::WriteLocal),
    ("bots_list", Effect::Read),
    ("bot_message", Effect::Network),
    // Asks another member of the group the bot is answering in, where the person sees it.
    ("group_ask", Effect::WriteLocal),
    ("web_fetch", Effect::Read),
    ("web_search", Effect::Read),
    ("research", Effect::Read),
    (crate::context::DOCUMENT_READ, Effect::Read),
    (GIT_PUSH, Effect::SendAsPerson),
    (PR_COMMENT, Effect::SendAsPerson),
    (ISSUE_COMMENT, Effect::SendAsPerson),
    (SEND_MESSAGE, Effect::SendAsPerson),
];

/// The typed tools that hold the person's sign-in outside the sandbox (ADR 0171 decision 2).
pub const GIT_PUSH: &str = "git_push";
pub const PR_COMMENT: &str = "pr_comment";
pub const ISSUE_COMMENT: &str = "issue_comment";
pub const SEND_MESSAGE: &str = "send_message";

/// What one of Spade's own tools does.
pub fn builtin(name: &str, risk: Risk) -> Option<Effect> {
    BUILTIN
        .iter()
        .find(|(tool, _)| *tool == name)
        .map(|(_, effect)| *effect)
        .or(match risk {
            Risk::Read => Some(Effect::Read),
            Risk::Memory => Some(Effect::WriteLocal),
            Risk::Write | Risk::Destructive => None,
        })
}

/// What an MCP tool (a connector's or a plugin's) says it does.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Mcp {
    /// `readOnlyHint: true`.
    pub read_only: bool,
    /// It sent any annotation at all.
    pub annotated: bool,
    /// What its catalogue entry or manifest declares for this tool.
    pub declared: Option<Effect>,
    /// What its catalogue entry declares for every tool of the app that isn't read-only.
    pub writes: Option<Effect>,
}

/// An MCP tool's effect: a declaration wins, then the annotations (`readOnlyHint` reads, any
/// other annotation acts outside the box); a tool that says nothing is undeclared.
pub fn mcp(tool: Mcp) -> Option<Effect> {
    if let Some(declared) = tool.declared {
        return Some(declared);
    }
    if tool.read_only {
        return Some(Effect::Read);
    }
    tool.writes.or(tool.annotated.then_some(Effect::Network))
}

/// What one of ace's tools does: ace's own risk, and a driving call (`browser_*`, `screen_*`,
/// `sim_*`) told to press a purchase button pays. ace's names never make a send: `agent_message`
/// messages one of the person's agents.
pub fn ace(name: &str, risk: Risk, arguments: &Value) -> Effect {
    if drives(name) && buys(arguments) {
        return Effect::Pay;
    }
    match risk {
        Risk::Read => Effect::Read,
        _ => Effect::Network,
    }
}

fn drives(name: &str) -> bool {
    ["browser_", "screen_", "sim_"]
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

/// What a button that completes a purchase says. Matched against the labels a driving call is
/// told to press or type, as whole phrases; a click on an element by its id alone says nothing.
const PURCHASE: &[&str] = &[
    "place order",
    "place your order",
    "buy now",
    "pay now",
    "checkout",
    "check out",
    "complete purchase",
    "confirm purchase",
    "complete payment",
    "confirm payment",
    "submit payment",
    "make payment",
    "book now",
    "confirm booking",
    "complete booking",
    "confirm and pay",
    "subscribe now",
    "start subscription",
    "send money",
];

fn buys(arguments: &Value) -> bool {
    fn texts<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
        match value {
            Value::String(text) => out.push(text),
            Value::Array(list) => list.iter().for_each(|v| texts(v, out)),
            Value::Object(map) => map.values().for_each(|v| texts(v, out)),
            _ => {}
        }
    }
    let mut found = Vec::new();
    texts(arguments, &mut found);
    found.iter().any(|text| {
        let said: Vec<String> = text
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .map(str::to_lowercase)
            .collect();
        let said = format!(" {} ", said.join(" "));
        PURCHASE
            .iter()
            .any(|phrase| said.contains(&format!(" {phrase} ")))
    })
}

/// Where a call runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Place {
    /// Spade, ace or an app runs it, outside any sandbox: its effect decides.
    Host,
    /// In a sandbox that holds files and network on this machine: the OS decides.
    Sandbox,
    /// A command the bot asks to run outside the sandbox, this once.
    AsksOutside,
    /// A command that runs with no sandbox (the bot's setting, the person's per-call answer, or
    /// a machine without one): the shell classifier's reading of it, for the review.
    Unsandboxed(Class),
}

/// Which grant covers a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Granted {
    No,
    /// A `tool` grant.
    Tool,
    /// A grant of the typed tool's own kind: `git_push` for a push, `pr_comment` for a comment.
    Typed,
}

/// What the gate knows about one call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Call<'a> {
    pub tool: &'a str,
    /// What the rule gate (ADR 0130) decided from risk, Always allow and taint.
    pub rule: Decision,
    pub risk: Risk,
    /// The person answered Always allow for this tool and scope.
    pub always: bool,
    /// `None`: the tool declares nothing.
    pub effect: Option<Effect>,
    /// For an undeclared tool, the person's answer for this bot, when they gave one.
    pub remembered: Option<bool>,
    pub place: Place,
    /// Untrusted content is in the model's view.
    pub tainted: bool,
    /// Its arguments name a place where sign-ins live (not checked for sandboxed calls).
    pub credentials: bool,
    /// It sets up standing work (a routine).
    pub standing: bool,
    /// Its arguments fit the reviewer's prompt whole.
    pub fits: bool,
    pub granted: Granted,
    /// A file write in the workspace a checkpoint can undo (ADR 0167 decision 8).
    pub checkpointed: bool,
}

/// Why the person is asked, when it isn't the usual request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Ask {
    /// The tool declares no effect; the answer is kept for the bot and tool.
    Undeclared,
    /// The bot asks to run one command outside the sandbox.
    OutsideSandbox,
}

/// A stored `ask`, read leniently: a word this build doesn't know is no `ask`.
pub fn lenient_ask<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Ask>, D::Error> {
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| serde_json::from_value(value).ok()))
}

/// Where a call goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Run,
    /// The person decides, with the line the request shows.
    Ask {
        line: String,
        ask: Option<Ask>,
    },
    /// The reviewer decides, told why Spade singled the call out, when it did.
    Review(Option<String>),
    /// Not run; the bot is told why.
    Refuse(String),
}

impl Route {
    fn ask(line: &str) -> Self {
        Self::Ask {
            line: line.to_owned(),
            ask: None,
        }
    }
}

/// Spade's own file writes, which need a checkpoint to run without a review.
const FILE_WRITES: &[&str] = &["workspace_write", "workspace_edit"];

pub fn route(call: Call<'_>) -> Route {
    if call.credentials {
        return Route::Refuse(autonomy::CREDENTIALS_REFUSED.to_owned());
    }
    // Outside the sandbox nothing is contained: the review path platforms without a sandbox use.
    if let Place::Unsandboxed(class) = call.place {
        return unsandboxed(call, class);
    }
    // What the person allowed always, as the rule gate saw it (taint still holds it).
    let allowed = call.always && call.rule == Decision::Run;
    let Some(effect) = call.effect else {
        if call.place == Place::Sandbox {
            return Route::Run;
        }
        return match call.remembered {
            // Allowed for the bot, but untrusted content could be steering this call: the
            // person decides it, as they would an always-allowed write (ADR 0130).
            Some(true) if call.tainted => Route::ask(UNDECLARED_TAINTED),
            Some(true) => Route::Run,
            Some(false) => Route::Refuse(DECLINED_TOOL.to_owned()),
            None => Route::Ask {
                line: UNDECLARED.to_owned(),
                ask: Some(Ask::Undeclared),
            },
        };
    };
    match effect {
        Effect::Credential => return Route::Refuse(autonomy::CREDENTIALS_REFUSED.to_owned()),
        // The person's alone, wherever it runs: no reviewer approves these.
        Effect::Pay | Effect::ChangeAccess if allowed => return Route::Run,
        Effect::Pay => return Route::ask(SPENDS),
        Effect::ChangeAccess => return Route::ask(CHANGES_ACCESS),
        Effect::SendAsPerson => {
            return match call.granted {
                _ if allowed => Route::Run,
                // The person granted this push or comment for that repository.
                Granted::Typed if !call.tainted => Route::Run,
                Granted::Typed if call.fits => Route::Review(Some(GRANTED_TAINTED.to_owned())),
                _ if call.tool == GIT_PUSH => Route::ask(PUSHES),
                _ => Route::ask(SENDS_AS_YOU),
            };
        }
        _ => {}
    }
    match call.place {
        Place::Sandbox => return Route::Run,
        Place::AsksOutside => {
            return Route::Ask {
                line: OUTSIDE.to_owned(),
                ask: Some(Ask::OutsideSandbox),
            };
        }
        Place::Host | Place::Unsandboxed(_) => {}
    }
    if call.standing && call.tainted {
        return review(call, Some(autonomy::Sensitive::TaintedRoutine.reason()));
    }
    match effect {
        Effect::Read => Route::Run,
        Effect::WriteLocal => {
            if call.checkpointed || call.rule == Decision::Run {
                return Route::Run;
            }
            // A file write no checkpoint can undo, and a note under untrusted content, keep the
            // review they had (ADR 0167 decisions 6 and 8).
            if FILE_WRITES.contains(&call.tool) || call.risk == Risk::Memory {
                return review(call, None);
            }
            Route::Run
        }
        Effect::Network => {
            if allowed || (call.granted != Granted::No && !call.tainted) {
                return Route::Run;
            }
            let concern = if call.granted != Granted::No {
                Some(GRANTED_TAINTED)
            } else if call.tainted {
                Some(TAINTED_OUTWARD)
            } else if call.risk == Risk::Destructive {
                Some(DELETES)
            } else {
                None
            };
            review(call, concern)
        }
        Effect::Publish if allowed => Route::Run,
        Effect::Publish => review(call, Some(PUBLISHES)),
        // Decided above.
        Effect::SendAsPerson | Effect::Pay | Effect::ChangeAccess | Effect::Credential => {
            Route::ask(UNDECLARED)
        }
    }
}

/// To the reviewer, unless it can't read the call whole.
fn review(call: Call<'_>, concern: Option<&str>) -> Route {
    if !call.fits {
        return Route::ask(TOO_LONG);
    }
    Route::Review(concern.map(str::to_owned))
}

/// A command with no sandbox: ADR 0163's route, with the shell classifier's class.
fn unsandboxed(call: Call<'_>, class: Class) -> Route {
    match autonomy::route(autonomy::Call {
        rule: call.rule,
        risk: call.risk,
        class,
        tainted: call.tainted,
        credentials: call.credentials,
        standing: call.standing,
        fits: call.fits,
        granted: call.granted == Granted::Tool,
    }) {
        autonomy::Route::Run => Route::Run,
        autonomy::Route::Ask(line) => Route::Ask { line, ask: None },
        autonomy::Route::Review(concern) => Route::Review(concern),
        autonomy::Route::Refuse(why) => Route::Refuse(why),
    }
}

/// The person's answer for an undeclared tool, kept for the bot (ADR 0171): their latest answer to
/// a request about `tool` asked because it declares nothing.
pub fn remembered(events: &[crate::Event], tool: &str) -> Option<bool> {
    use crate::event::{Event, Known};
    let asked: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            Event::Known(Known::ApprovalRequested {
                call_id,
                name,
                ask: Some(Ask::Undeclared),
                ..
            }) if name == tool => Some(call_id.as_str()),
            _ => None,
        })
        .collect();
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::ApprovalAnswered {
            call_id, allowed, ..
        }) if asked.contains(&call_id.as_str()) => Some(*allowed),
        _ => None,
    })
}

/// Why a tool can never be granted (ADR 0167 decision 5), from what it declares: payments,
/// sends in the person's name, access changes and secrets are the person's alone.
pub fn never_granted(effect: Option<Effect>) -> Option<&'static str> {
    match effect? {
        Effect::Pay => Some("It could spend money."),
        Effect::SendAsPerson => Some("It sends something in the person's name."),
        Effect::ChangeAccess | Effect::Credential => {
            Some("It changes sign-ins, keys or who has access.")
        }
        _ => None,
    }
}

pub const SPENDS: &str = "It could spend money, so you decide.";
pub const SENDS_AS_YOU: &str = "It sends something in your name, so you decide.";
pub const PUSHES: &str = "It pushes with your sign-in, so you decide.";
pub const CHANGES_ACCESS: &str = "It changes sign-ins, keys or who has access, so you decide.";
pub const UNDECLARED: &str = "It doesn't say what it does, so you decide once for this bot.";
pub const UNDECLARED_TAINTED: &str =
    "It doesn't say what it does and untrusted content is in view, so you decide.";
pub const OUTSIDE: &str = "It asks to run outside the sandbox, so you decide.";
pub const DECLINED_TOOL: &str = "The person declined this tool for this bot.";
const PUBLISHES: &str = "It posts or publishes something.";
const DELETES: &str = "It may delete or overwrite something outside the bot.";
const TAINTED_OUTWARD: &str = "It acts outside the bot's folder after reading untrusted content.";
const GRANTED_TAINTED: &str = "A grant of the person's covers it, but untrusted content is in view: check its arguments \
     came from the person or the bot's own work, not from that content.";
const TOO_LONG: &str = "It is too long for the reviewer to read whole, so you decide.";

/// What stopped a sandboxed command, read from its output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Blocked {
    Files,
    Network,
    App,
}

/// What a sandboxed command's output says the sandbox refused it, if anything. Each marker is
/// one the sandbox or Spade's proxy prints: a denied file, a refused host or a name that
/// can't resolve (there is no DNS inside), an app it can't reach.
pub fn blocked(output: &str) -> Option<Blocked> {
    const MARKERS: &[(&str, Blocked)] = &[
        ("network policy for this bot refused it", Blocked::Network),
        ("response 403", Blocked::Network),
        ("Received HTTP code 403 from proxy", Blocked::Network),
        ("Could not resolve host", Blocked::Network),
        ("nodename nor servname provided", Blocked::Network),
        ("getaddrinfo ENOTFOUND", Blocked::Network),
        ("Not authorized to send Apple events", Blocked::App),
        ("(-1743)", Blocked::App),
        ("(-609)", Blocked::App),
        ("(-600)", Blocked::App),
        ("LSOpenURLsWithRole", Blocked::App),
        ("Operation not permitted", Blocked::Files),
        ("sandbox-exec:", Blocked::Files),
    ];
    MARKERS
        .iter()
        .find(|(marker, _)| output.contains(marker))
        .map(|(_, kind)| *kind)
}

/// What the bot is told after a sandboxed command the sandbox stopped.
pub fn blocked_hint(kind: Blocked) -> &'static str {
    match kind {
        Blocked::Files => {
            "[The sandbox stopped this: it can't read or write that place. If the step truly \
             needs it, call shell again with outside_sandbox: true and the person is asked.]"
        }
        Blocked::Network => {
            "[The sandbox stopped this: that host isn't allowed for this bot. If the step truly \
             needs it, call shell again with outside_sandbox: true and the person is asked, or \
             ask them to allow the host.]"
        }
        Blocked::App => {
            "[The sandbox stopped this: commands can't reach other apps. If the step truly \
             needs it, call shell again with outside_sandbox: true and the person is asked.]"
        }
    }
}

#[cfg(test)]
mod tests;
