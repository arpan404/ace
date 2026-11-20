//! `spade.v1`, the runtime API (ADR 0200 §4, spade/docs/runtime.md): stable names for the tools
//! every bot gets, grouped into modules. It adds a module and a `since` column to the gate's own
//! table: a Spade tool's effect is read from [`super::BUILTIN`], the one place the gate reads it,
//! so the API and the gate can't drift apart. A name that leaves the API stays working as an alias
//! for at least six months (§4.3). Pure data and lookups.

use super::Effect;

/// The API's major version: a package's `requires.runtime`.
pub const VERSION: &str = "1";

/// The build that first named `spade.v1`.
const V1: &str = "0.0.24";

/// A module of the API, in the order the reference lists them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Module {
    Task,
    Memory,
    Files,
    Web,
    Apps,
    Agents,
    Ui,
    Schedule,
    Devices,
    Outward,
    Notify,
}

impl Module {
    pub const ALL: [Self; 11] = [
        Self::Task,
        Self::Memory,
        Self::Files,
        Self::Web,
        Self::Apps,
        Self::Agents,
        Self::Ui,
        Self::Schedule,
        Self::Devices,
        Self::Outward,
        Self::Notify,
    ];

    /// The word a package's `uses` names it by.
    pub fn name(self) -> &'static str {
        match self {
            Self::Task => "task",
            Self::Memory => "memory",
            Self::Files => "files",
            Self::Web => "web",
            Self::Apps => "apps",
            Self::Agents => "agents",
            Self::Ui => "ui",
            Self::Schedule => "schedule",
            Self::Devices => "devices",
            Self::Outward => "outward",
            Self::Notify => "notify",
        }
    }

    pub fn parse(word: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|m| m.name() == word.trim())
    }

    /// One line on what the module is, for the reference.
    pub fn about(self) -> &'static str {
        match self {
            Self::Task => "The bot's goal, plan and where its task stands; its own task and face.",
            Self::Memory => {
                "Notes, the knowledge base, past episodes and the conversation's history."
            }
            Self::Files => "The bot's workspace, its sandboxed shell and the services it owns.",
            Self::Web => "Searching and reading the web.",
            Self::Apps => {
                "The person's connected apps and allowed plugins. Their own tools are offered \
                 deferred and gated, and their output is untrusted; their names are the apps', \
                 not part of this API."
            }
            Self::Agents => "Other bots, clubs, workers, helpers and ace's coding agents.",
            Self::Ui => "What the person sees besides the reply: questions, images and cards.",
            Self::Schedule => "Routines, wakes and waits.",
            Self::Devices => {
                "ace's browser, screen and simulators, and devices named with @, through ace."
            }
            Self::Outward => "Pushes, comments and messages with the person's own sign-ins.",
            Self::Notify => "Proactive notices to the person. Phase 2; no tools yet.",
        }
    }
}

/// Where the gate reads a tool's effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// Spade's own tool: the gate's table.
    Table,
    /// One of ace's tools: ace's own declaration and risk, at most this.
    Ace(Effect),
    /// `call_tool`: the effect of the tool it calls.
    Called,
}

/// One tool of the API. A name ending in `*` stands for every tool with that prefix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tool {
    pub name: &'static str,
    pub module: Module,
    pub source: Source,
    /// The build that added it.
    pub since: &'static str,
}

const fn spade(name: &'static str, module: Module) -> Tool {
    Tool {
        name,
        module,
        source: Source::Table,
        since: V1,
    }
}

const fn ace(name: &'static str, module: Module, most: Effect) -> Tool {
    Tool {
        name,
        module,
        source: Source::Ace(most),
        since: V1,
    }
}

use Module::{Agents, Apps, Devices, Files, Memory, Outward, Schedule, Task, Ui, Web};

/// `spade.v1`. Add a tool with the build that adds it; never remove or rename one, or give it a
/// stronger effect, without an alias in [`ALIASES`] (that is `spade.v2`).
pub const TOOLS: &[Tool] = &[
    spade(crate::goal::TASK_GOAL, Task),
    spade(crate::goal::TASK_PLAN, Task),
    spade(crate::task::TASK_STATUS, Task),
    spade(crate::self_edit::TASK_UPDATE, Task),
    spade("todo", Task),
    spade(crate::self_edit::PROFILE_UPDATE, Task),
    spade("memory_save", Memory),
    spade("memory_update", Memory),
    spade("memory_forget", Memory),
    spade("memory_search", Memory),
    spade("knowledge_write", Memory),
    spade("knowledge_update", Memory),
    spade("knowledge_forget", Memory),
    spade("knowledge_link", Memory),
    spade("knowledge_merge", Memory),
    spade("knowledge_read", Memory),
    spade("knowledge_search", Memory),
    spade("episode_search", Memory),
    spade("history_read", Memory),
    spade("history_search", Memory),
    spade("about_person", Memory),
    spade("workspace_list", Files),
    spade("workspace_read", Files),
    spade("workspace_search", Files),
    spade("workspace_write", Files),
    spade("workspace_edit", Files),
    spade(crate::context::DOCUMENT_READ, Files),
    spade("share_file", Files),
    spade("shell", Files),
    spade("service_start", Files),
    spade("service_status", Files),
    spade("service_logs", Files),
    spade("service_stop", Files),
    spade("web_search", Web),
    spade("web_fetch", Web),
    spade("research", Web),
    spade("apps_find", Apps),
    spade("app_connect_request", Apps),
    spade(crate::tools::TOOL_SEARCH, Apps),
    Tool {
        name: crate::tools::CALL_TOOL,
        module: Apps,
        source: Source::Called,
        since: V1,
    },
    spade("bots_list", Agents),
    spade("bot_message", Agents),
    spade("group_ask", Agents),
    spade(crate::made::CLUB_ADD, Agents),
    spade(crate::tree::BOT_CREATE, Agents),
    spade(crate::tree::WORKER_MESSAGE, Agents),
    spade(crate::tree::WORKER_STATUS, Agents),
    spade(crate::tree::WORKER_RESULT, Agents),
    spade(crate::tree::WORKER_STOP, Agents),
    spade(crate::helper::TOOL, Agents),
    ace("delegate", Agents, Effect::Network),
    spade(crate::context::ASK_USER, Ui),
    spade("image_generate", Ui),
    spade(crate::card::CARD_SHOW, Ui),
    spade("routines_list", Schedule),
    spade("routine_save", Schedule),
    spade("routine_delete", Schedule),
    spade(crate::wake::SLEEP_UNTIL, Schedule),
    spade(crate::wake::WAIT_FOR, Schedule),
    spade(crate::wake::WAKE_CANCEL, Schedule),
    ace("browser_*", Devices, Effect::Drive),
    ace("screen_*", Devices, Effect::Drive),
    ace("sim_*", Devices, Effect::Drive),
    spade(super::GIT_PUSH, Outward),
    spade(super::PR_COMMENT, Outward),
    spade(super::ISSUE_COMMENT, Outward),
    spade(super::SEND_MESSAGE, Outward),
];

/// Spade's tools in the gate's table that are not part of the API: they may change in any build.
pub const INTERNAL: &[&str] = &[
    crate::decision::DECISION_LOG,
    "skill_search",
    "skill_load",
    "skill_propose",
    "skill_feedback",
];

/// A name that left the API, kept working as another tool (§4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Alias {
    pub name: &'static str,
    /// The tool it now calls.
    pub to: &'static str,
    /// The day the rename shipped, and the first day it may go (`YYYY-MM-DD`): at least six
    /// months later, and only while no listed package still requires the version it was in.
    pub from: &'static str,
    pub until: &'static str,
}

/// Names kept working after a change. None yet: `spade.v1` is the first version.
pub const ALIASES: &[Alias] = &[];

/// The API tool `name` is, directly or by a pattern (`browser_click` is `browser_*`).
pub fn tool(name: &str) -> Option<&'static Tool> {
    TOOLS.iter().find(|tool| match tool.name.strip_suffix('*') {
        Some(prefix) => name.starts_with(prefix),
        None => tool.name == name,
    })
}

/// The tool a call to `name` runs: itself, or what its alias now calls.
pub fn resolve(name: &str) -> &str {
    ALIASES
        .iter()
        .find(|alias| alias.name == name)
        .map_or(name, |alias| alias.to)
}

/// What the API says a call to `name` does at most, after aliases: the gate's table for Spade's
/// tools, ace's rule for ace's. `None` for a name outside the API, or for `call_tool`, whose
/// effect is the called tool's.
pub fn effect(name: &str) -> Option<Effect> {
    let tool = tool(resolve(name))?;
    match tool.source {
        Source::Table => super::table(tool.name),
        Source::Ace(most) => Some(most),
        Source::Called => None,
    }
}

/// The reference, `spade/docs/runtime.md`, written from the table.
pub fn markdown() -> String {
    let mut out = String::from(
        "# The runtime API, `spade.v1`\n\n\
         <!-- Written from `spade_core::effect::runtime`. Don't edit by hand: change the table and \
         run `SPADE_WRITE_RUNTIME_DOC=1 cargo test -p spade-core runtime_doc`. -->\n\n\
         The tools every Spade bot gets, under stable names (ADR 0200 §4). They are Spade's \
         built-in tools, gated as always: a call goes through the effects gate, the sandbox, the \
         reviewer or the person. This is not an SDK; nothing a package brings runs in Spade's \
         process.\n\n\
         A package says which version it needs with `requires.runtime` (now `",
    );
    out.push_str(VERSION);
    out.push_str(
        "`) and narrows its bot's tools to the modules it `uses`.\n\n\
         **Effects** are ADR 0171's words, from least to most serious: `read`, `write_local`, \
         `network`, `publish`, `send_as_person`, `pay`, `drive`, `change_access`. Each Spade \
         tool's effect is read from the same table the gate decides with.\n\n\
         ## Versions\n\n\
         - **A minor change** adds a tool, an optional argument or a field in an answer. A package \
         that requires runtime `1` keeps working; `requires.spade` names the build whose additions \
         it needs (the `Since` column).\n\
         - **A major change** renames or removes a tool, changes what an argument means or an \
         answer's shape, or gives a tool a stronger effect. That is `spade.v2`. Each v1 name keeps \
         working as an alias for at least six months, and while any listed package still \
         requires v1, with a note below.\n\
         - A test walks the table and fails when a v1 tool goes missing or its effect gets \
         stronger without an alias.\n\n",
    );
    for module in Module::ALL {
        out.push_str(&format!("## `{}`\n\n{}\n\n", module.name(), module.about()));
        let tools: Vec<&Tool> = TOOLS.iter().filter(|t| t.module == module).collect();
        if tools.is_empty() {
            continue;
        }
        out.push_str("| Tool | Effect | Since |\n| --- | --- | --- |\n");
        for tool in tools {
            let effect = match tool.source {
                Source::Table => super::table(tool.name).map_or("?", Effect::name).to_owned(),
                Source::Ace(Effect::Drive) => "`read`, or `drive` when it acts (ace's)".to_owned(),
                Source::Ace(most) => format!("`{}` (ace's)", most.name()),
                Source::Called => "the called tool's".to_owned(),
            };
            let effect = if effect.starts_with('`') || effect.contains(' ') {
                effect
            } else {
                format!("`{effect}`")
            };
            out.push_str(&format!(
                "| `{}` | {effect} | {} |\n",
                tool.name, tool.since
            ));
        }
        out.push('\n');
    }
    out.push_str("## Aliases\n\n");
    if ALIASES.is_empty() {
        out.push_str("None. `spade.v1` is the first version.\n");
    } else {
        out.push_str("| Old name | Now calls | Since | Kept until |\n| --- | --- | --- | --- |\n");
        for alias in ALIASES {
            out.push_str(&format!(
                "| `{}` | `{}` | {} | {} |\n",
                alias.name, alias.to, alias.from, alias.until
            ));
        }
    }
    out.push_str(
        "\n## Not part of the API\n\n\
         Harness internals (compaction, titles, the check of done) and these tools, which may \
         change in any build: ",
    );
    out.push_str(
        &INTERNAL
            .iter()
            .map(|name| format!("`{name}`"))
            .collect::<Vec<_>>()
            .join(", "),
    );
    out.push_str(".\n");
    out
}

/// What breaks a published version: each name in `published` must still be a tool whose effect,
/// as `now` reads it, is no stronger, or an alias kept at least six months onto one that is.
/// Empty when nothing breaks.
pub fn breaks(
    published: &[(&str, Effect)],
    now: impl Fn(&str) -> Option<Option<Effect>>,
    aliases: &[Alias],
) -> Vec<String> {
    let mut out = Vec::new();
    for (name, was) in published {
        let alias = aliases.iter().find(|alias| alias.name == *name);
        if let Some(alias) = alias {
            match days(alias.until).zip(days(alias.from)) {
                Some((until, from)) if until - from >= SIX_MONTHS_DAYS => {}
                _ => out.push(format!(
                    "{name}: its alias must be kept at least six months"
                )),
            }
        }
        let target = alias.map_or(*name, |alias| alias.to);
        match now(target) {
            None => out.push(format!("{name}: gone without an alias")),
            Some(Some(effect)) if effect > *was && alias.is_none() => out.push(format!(
                "{name}: its effect rose from {} to {} without an alias",
                was.name(),
                effect.name()
            )),
            Some(_) => {}
        }
    }
    out
}

/// Six months, at their shortest.
const SIX_MONTHS_DAYS: i64 = 181;

/// Days since 1970-01-01 of a `YYYY-MM-DD` date.
fn days(date: &str) -> Option<i64> {
    let date: jiff::civil::Date = date.parse().ok()?;
    Some(i64::from(
        date.since(jiff::civil::date(1970, 1, 1)).ok()?.get_days(),
    ))
}

/// Every API tool now, as [`breaks`] reads it: present, with its effect (`None` for `call_tool`).
pub fn now(name: &str) -> Option<Option<Effect>> {
    tool(name).map(|_| effect(name))
}

#[cfg(test)]
mod tests;
