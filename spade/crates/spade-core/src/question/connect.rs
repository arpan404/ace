//! A card asking the person to connect an app (`app_connect_request`, ADR 0131 amendment 1):
//! a kind of question only Spade makes, from the catalogue and the person's connectors, never
//! from what the bot wrote beyond its reason. The person answers it by connecting the app (or
//! giving it to the bot); Spade stores that as the card's answer, so waiting, Later, Not now,
//! restarts and late answers are the question card's own (ADR 0154).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Kind, Question};

/// The tool a bot calls to ask the person to connect an app.
pub const APP_CONNECT_REQUEST: &str = "app_connect_request";
/// The tool a bot calls to find which catalogue apps fit a need.
pub const APPS_FIND: &str = "apps_find";

/// How the person gives the bot the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Way {
    /// Sign in once, in the browser.
    SignIn,
    /// A token or key the person makes in the app.
    Key,
    /// It can't be connected on this build yet: the card says so, and nothing waits.
    Later,
    /// Already connected for other bots: the person only lets this one use it.
    Use,
    /// Connected once, but its sign-in expired or was revoked: the person signs in again.
    Reconnect,
}

/// The app a connect card is about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Connect {
    /// Its catalogue entry, or for a server added by address, its connector.
    pub app: String,
    pub name: String,
    pub way: Way,
    /// What the bot may do with it, a few words each, from the catalogue.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub can: Vec<String>,
    /// The person's connector for it, when there is one already (`use`, `reconnect`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connector: Option<String>,
    /// Where the person makes a key, for `key`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_url: Option<String>,
    /// The card holds a call that didn't run because the sign-in had expired: once reconnected,
    /// Spade runs it again.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub retry: bool,
}

/// What the person's connecting stores as the card's answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Connected {
    pub connector: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// Every bot was let use it, not only the one that asked.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub everyone: bool,
}

impl Connected {
    pub fn answer(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    pub fn read(answer: &Value) -> Option<Self> {
        serde_json::from_value(answer.clone()).ok()
    }
}

/// The card's one question.
pub fn question(why: String, connect: Connect) -> Question {
    Question {
        id: None,
        prompt: why,
        kind: Kind::Connect(Box::new(connect)),
    }
}

/// The app a card's questions ask to connect, when it is a connect card.
pub fn of(questions: &[Question]) -> Option<&Connect> {
    match questions {
        [
            Question {
                kind: Kind::Connect(connect),
                ..
            },
        ] => Some(connect),
        _ => None,
    }
}

/// The card's one-line summary, as `question_asked.question` keeps it.
pub fn summary(connect: &Connect, why: &str) -> String {
    let verb = if connect.way == Way::Reconnect {
        "Reconnect"
    } else {
        "Connect"
    };
    format!("{verb} {}: {why}", connect.name)
}

fn account(connected: Option<&Connected>) -> String {
    connected
        .and_then(|c| c.account.as_deref())
        .map(|a| format!(" as {a}"))
        .unwrap_or_default()
}

/// What the waiting call reads once the person connected the app.
pub fn connected(connect: &Connect, answer: &Value) -> String {
    format!(
        "The person connected {}{}. Its tools are yours now: find them with tool_search and \
         carry on.",
        connect.name,
        account(Connected::read(answer).as_ref())
    )
}

/// What a late answer reads, inside its `<question_answer>`.
pub fn connected_late(connect: &Connect, answer: &Value) -> String {
    let again = if connect.retry {
        " Try the call again if you still need it."
    } else {
        ""
    };
    format!(
        "{} is connected now{}; its tools are yours: find them with tool_search.{again}",
        connect.name,
        account(Connected::read(answer).as_ref())
    )
}

/// What the waiting call reads when the person chose Later.
pub fn deferred(connect: &Connect) -> String {
    let start = if connect.retry {
        format!(
            "Not run: the sign-in to {} expired, and the person will reconnect it later.",
            connect.name
        )
    } else {
        format!("The person will connect {} later.", connect.name)
    };
    format!(
        "{start} Go on without it where you can, or end your reply saying what waits on it. When \
         they connect it you'll get a <question_answer>."
    )
}

/// What the bot reads when the person said Not now, or the app isn't available yet.
pub fn dismissed(connect: &Connect) -> String {
    match (connect.way, connect.retry) {
        (Way::Later, _) => format!(
            "{} can't be connected yet: it isn't available in Spade so far. Carry on without it, \
             and tell the person what you couldn't do.",
            connect.name
        ),
        (_, true) => format!(
            "Not run: the sign-in to {} expired, and the person chose not to reconnect it now. \
             Carry on without it.",
            connect.name
        ),
        _ => format!(
            "The person chose not to connect {} now. Carry on without it, and don't ask again for \
             this task.",
            connect.name
        ),
    }
}

/// What the bot reads at once when it asked for an app it can already use.
pub fn already(name: &str) -> String {
    format!("{name} is connected and yours to use: find its tools with tool_search.")
}

/// What a connect card answered in the card checks: never an answer the person posts, since
/// only connecting answers it.
pub const ANSWERED_BY_CONNECTING: &str =
    "this asks to connect an app: connect it, or choose Later or Not now.";
