//! A bot's browser and screen as ace keeps them (ADR 0142, `packages/protocol/src/spade-computer.ts`):
//! who drives them, the bot's tabs and apps, and what the person did while they drove. Spade asks
//! the daemon over its loopback socket (`spade.computer.get`, `spade.computer.drive`); the daemon
//! keeps the driver in memory only, so Spade sends it again until the daemon has it.

use std::pin::Pin;

use serde::Deserialize;

use super::Driver;

pub type BoxFuture<'a, T> = Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// One of the bot's tabs.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub tab_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
    /// `user` for a tab in the person's own browser, which ace doesn't stream.
    #[serde(default)]
    pub backend: Option<String>,
}

/// What the person did with the bot's browser and screen while they drove (`SpadeComputerHandback`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handback {
    #[serde(default)]
    pub driven_ms: u64,
    /// Addresses the bot's tabs went to, in order, without repeats.
    #[serde(default)]
    pub visited: Vec<String>,
    #[serde(default)]
    pub opened: Vec<Tab>,
    #[serde(default)]
    pub closed: Vec<Tab>,
    #[serde(default)]
    pub screen_used: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Browser {
    #[serde(default)]
    pub tabs: Vec<Tab>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Screen {
    #[serde(default)]
    pub apps: Vec<String>,
    #[serde(default)]
    pub since: Option<i64>,
}

/// A bot's computer as ace keeps it (`SpadeComputer`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AceComputer {
    pub driver: Driver,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub browser: Browser,
    #[serde(default)]
    pub screen: Screen,
}

/// The daemon, as the computers need it. The ace link answers it; tests stand in for it.
pub trait Daemon: Send + Sync {
    /// Sets who drives the bot's browser and screen. When the person hands back, what they did.
    fn drive<'a>(
        &'a self,
        bot: &'a str,
        driver: Driver,
    ) -> BoxFuture<'a, Result<Option<Handback>, String>>;

    /// The bot's browser and screen now.
    fn computer<'a>(&'a self, bot: &'a str) -> BoxFuture<'a, Result<AceComputer, String>>;
}

/// Reads a `spade.computer.drive.result`'s fields.
pub fn drive_answer(answer: &serde_json::Value) -> Result<Option<Handback>, String> {
    if let Some(error) = answer.get("error").and_then(serde_json::Value::as_str) {
        return Err(format!("ace refused: {error}"));
    }
    Ok(answer
        .get("handback")
        .and_then(|handback| serde_json::from_value(handback.clone()).ok()))
}

/// Reads a `spade.computer.result`'s fields.
pub fn computer_answer(answer: &serde_json::Value) -> Result<AceComputer, String> {
    if let Some(error) = answer.get("error").and_then(serde_json::Value::as_str) {
        return Err(format!("ace refused: {error}"));
    }
    answer
        .get("computer")
        .cloned()
        .ok_or_else(|| "ace sent no computer".to_owned())
        .and_then(|computer| serde_json::from_value(computer).map_err(|e| e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_handback_and_a_computer_are_read_from_aces_answers() {
        let answer = json!({ "driver": "bot", "handback": {
            "drivenMs": 60000, "visited": ["https://a.example/"],
            "opened": [{ "tabId": "t2", "title": "A", "url": "https://a.example/" }],
            "closed": [], "screenUsed": true } });
        let handback = drive_answer(&answer).unwrap_or_default();
        assert_eq!(handback.as_ref().map(|h| h.driven_ms), Some(60000));
        assert!(handback.is_some_and(|h| h.screen_used && h.opened[0].tab_id == "t2"));
        assert_eq!(drive_answer(&json!({ "driver": "person" })), Ok(None));
        assert!(drive_answer(&json!({ "error": "forbidden" })).is_err());

        let computer = computer_answer(&json!({ "computer": {
            "bot": "a_1", "driver": "person", "threadId": "th_1",
            "browser": { "tabs": [{ "tabId": "t1", "title": "Docs", "url": "https://d.example/",
                                    "backend": "user", "added": "later" }] },
            "screen": { "apps": ["Notes"], "since": 5 } } }));
        assert!(computer.is_ok_and(|c| c.driver == Driver::Person
            && c.thread_id.as_deref() == Some("th_1")
            && c.screen.apps == ["Notes"]
            && c.browser.tabs[0].backend.as_deref() == Some("user")));
        assert!(computer_answer(&json!({ "error": "unavailable" })).is_err());
    }
}
