//! What a local model can do, measured rather than guessed (ADR 0205 §3). When a model on this
//! computer is added, Spade sends it three fixed checks, one after the other: a plain answer,
//! one call of a fake tool, and an answer shaped by a small JSON Schema. Each passes, fails, or
//! couldn't be run (the server didn't answer at all), and what they found sets the model's
//! `tools`. The checks go only to the person's own server, so they cost nothing.

use std::future::Future;
use std::time::Duration;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::catalog::Capability;
use crate::client::Models;
use crate::error::ModelError;
use crate::prompt::{Prompt, ToolSpec};

/// How long one check may take: a local server loading a model from disk first can be slow.
pub const PROBE_WAIT: Duration = Duration::from_secs(120);

/// The fake tool the tool check offers.
pub const PROBE_TOOL: &str = "get_weather";

/// How one check ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Probe {
    Passed,
    /// The model answered, and not as asked (or not in time).
    Failed,
    /// The server never answered, so the model's abilities weren't measured.
    Unreached,
}

/// What the three checks found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProbeResults {
    pub plain: Probe,
    pub tools: Probe,
    pub structured: Probe,
}

impl ProbeResults {
    /// Whether every check reached the model, so its results say what it can do.
    pub fn measured(&self) -> bool {
        [self.plain, self.tools, self.structured]
            .iter()
            .all(|p| *p != Probe::Unreached)
    }

    /// Whether the model called the fake tool as asked.
    pub fn calls_tools(&self) -> bool {
        self.tools == Probe::Passed
    }

    /// `capabilities` with `tools` set as measured; `None` when the checks didn't reach the
    /// model, so nothing is learned. What the checks don't look at (images, say) is kept.
    pub fn capabilities(&self, capabilities: &[Capability]) -> Option<Vec<Capability>> {
        if !self.measured() {
            return None;
        }
        let mut next: Vec<Capability> = capabilities
            .iter()
            .copied()
            .filter(|c| *c != Capability::Tools)
            .collect();
        if self.calls_tools() {
            next.insert(0, Capability::Tools);
        }
        Some(next)
    }
}

/// The structured check's answer.
#[derive(Debug, Deserialize, JsonSchema)]
struct Capital {
    city: String,
    letters: u32,
}

/// How a failed call reads as a check: a server that never answered wasn't reached; anything
/// else is the model's answer.
fn ended(error: &ModelError) -> Probe {
    match error.unserved() {
        Some(crate::Unserved::Unreachable) => Probe::Unreached,
        _ => Probe::Failed,
    }
}

async fn within<T>(call: impl Future<Output = Result<T, ModelError>>) -> Result<T, Probe> {
    match tokio::time::timeout(PROBE_WAIT, call).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(ended(&error)),
        Err(_) => Err(Probe::Failed),
    }
}

impl Models {
    /// Runs the three checks on `reference`, in order.
    pub async fn probe(&self, reference: &str) -> ProbeResults {
        let plain = match within(self.chat(
            reference,
            &Prompt::ask("Say hello to the person in one short sentence."),
        ))
        .await
        {
            Ok(reply) if !reply.text.trim().is_empty() => Probe::Passed,
            Ok(_) => Probe::Failed,
            Err(probe) => probe,
        };
        let weather = ToolSpec {
            name: PROBE_TOOL.to_owned(),
            description: "Gets today's weather for a city.".to_owned(),
            schema: json!({
                "type": "object",
                "properties": { "city": { "type": "string" } },
                "required": ["city"],
            }),
        };
        let tools = match within(
            self.chat(
                reference,
                &Prompt::ask("What is the weather in Lisbon today? Use the tool to find out.")
                    .tools(vec![weather]),
            ),
        )
        .await
        {
            Ok(reply) => {
                let called = reply.calls.iter().any(|call| {
                    call.name == PROBE_TOOL
                        && call
                            .arguments
                            .get("city")
                            .and_then(|c| c.as_str())
                            .is_some_and(|c| !c.trim().is_empty())
                });
                if called { Probe::Passed } else { Probe::Failed }
            }
            Err(probe) => probe,
        };
        let structured = match within(self.generate::<Capital>(
            reference,
            &Prompt::ask(
                "Name the capital of France and count the letters in its name. Answer only \
                 with JSON: {\"city\": string, \"letters\": number}.",
            ),
        ))
        .await
        {
            Ok(answer) if !answer.value.city.trim().is_empty() && answer.value.letters > 0 => {
                Probe::Passed
            }
            Ok(_) => Probe::Failed,
            Err(probe) => probe,
        };
        ProbeResults {
            plain,
            tools,
            structured,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn results(plain: Probe, tools: Probe, structured: Probe) -> ProbeResults {
        ProbeResults {
            plain,
            tools,
            structured,
        }
    }

    #[test]
    fn a_model_that_calls_the_tool_gets_tools_and_keeps_what_wasnt_checked() {
        let all = results(Probe::Passed, Probe::Passed, Probe::Passed);
        assert_eq!(
            all.capabilities(&[Capability::Images]),
            Some(vec![Capability::Tools, Capability::Images])
        );
        let no_tools = results(Probe::Passed, Probe::Failed, Probe::Passed);
        assert_eq!(
            no_tools.capabilities(&[Capability::Tools, Capability::Images]),
            Some(vec![Capability::Images])
        );
    }

    #[test]
    fn checks_that_never_reached_the_model_teach_nothing() {
        let off = results(Probe::Unreached, Probe::Unreached, Probe::Unreached);
        assert_eq!(off.capabilities(&[Capability::Tools]), None);
        let partly = results(Probe::Passed, Probe::Unreached, Probe::Passed);
        assert!(!partly.measured());
        assert_eq!(partly.capabilities(&[]), None);
    }
}
