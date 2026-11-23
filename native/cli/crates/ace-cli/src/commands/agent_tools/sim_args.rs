// SPDX-License-Identifier: Apache-2.0
//! Pure `ace sim` argument mapping: words and flags to the verb and the sim tool's own
//! arguments. Ports `apps/daemon/src/cli/sim-args.ts` exactly; I/O lives in `sim.rs`.

use cli_out::{Failure, Flags};

use super::sim_act::{act_args, defined, optional_number, usage};

/// The `ace sim` verbs, each the sim_* MCP tool of the same name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SimVerb {
    List,
    Start,
    Stop,
    Ui,
    Act,
    Screenshot,
    Logs,
}

impl SimVerb {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::List => "list",
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Ui => "ui",
            Self::Act => "act",
            Self::Screenshot => "screenshot",
            Self::Logs => "logs",
        }
    }

    fn from_command(id: &str) -> Option<Self> {
        match id {
            "sim.list" => Some(Self::List),
            "sim.start" => Some(Self::Start),
            "sim.stop" => Some(Self::Stop),
            "sim.ui" => Some(Self::Ui),
            "sim.act" => Some(Self::Act),
            "sim.screenshot" => Some(Self::Screenshot),
            "sim.logs" => Some(Self::Logs),
            _ => None,
        }
    }
}

/// One mapped call: the verb and the tool's own arguments as JSON.
pub struct SimCall {
    pub verb: SimVerb,
    pub args: serde_json::Value,
}

/// Pure: `ace sim …` words and flags to the verb and the sim tool's own arguments.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
#[allow(
    clippy::too_many_lines,
    reason = "one verb table, mirroring sim-args.ts in order"
)]
pub fn sim_call(
    command_id: &str,
    words: &[&str],
    flags: &Flags<'_>,
) -> Result<SimCall, Failure<'static>> {
    let Some(verb) = SimVerb::from_command(command_id) else {
        return Err(usage("Unknown ace sim verb. See ace help sim act."));
    };
    if verb == SimVerb::List {
        if !words.is_empty() {
            return Err(usage("ace sim list takes no arguments."));
        }
        return Ok(SimCall {
            verb,
            args: serde_json::Value::Object(serde_json::Map::new()),
        });
    }
    let Some(sim_id) = words.first() else {
        return Err(usage(format!("ace sim {} needs a SIM id.", verb.as_str())));
    };
    let rest = &words[1..];
    match verb {
        SimVerb::List => Err(usage("ace sim list takes no arguments.")),
        SimVerb::Start => {
            if !rest.is_empty() {
                return Err(usage("Too many arguments. See ace help sim act."));
            }
            Ok(SimCall {
                verb,
                args: defined(vec![
                    (
                        "simId".to_owned(),
                        Some(serde_json::Value::String((*sim_id).to_owned())),
                    ),
                    (
                        "boot".to_owned(),
                        Some(serde_json::Value::Bool(!flags.on("no-boot"))),
                    ),
                ]),
            })
        }
        SimVerb::Stop | SimVerb::Screenshot => {
            if !rest.is_empty() {
                return Err(usage("Too many arguments. See ace help sim act."));
            }
            Ok(SimCall {
                verb,
                args: defined(vec![(
                    "simId".to_owned(),
                    Some(serde_json::Value::String((*sim_id).to_owned())),
                )]),
            })
        }
        SimVerb::Logs => {
            if !rest.is_empty() {
                return Err(usage("Too many arguments. See ace help sim act."));
            }
            Ok(SimCall {
                verb,
                args: defined(vec![
                    (
                        "simId".to_owned(),
                        Some(serde_json::Value::String((*sim_id).to_owned())),
                    ),
                    (
                        "limit".to_owned(),
                        optional_number(flags, "limit")?.map(serde_json::Value::Number),
                    ),
                ]),
            })
        }
        SimVerb::Ui => {
            if rest.len() > 1 {
                return Err(usage("Too many arguments. See ace help sim act."));
            }
            let named: Option<String> = rest
                .first()
                .copied()
                .map(str::to_owned)
                .or_else(|| flags.value("name").map(str::to_owned));
            Ok(SimCall {
                verb,
                args: defined(vec![
                    (
                        "simId".to_owned(),
                        Some(serde_json::Value::String((*sim_id).to_owned())),
                    ),
                    ("name".to_owned(), named.map(serde_json::Value::String)),
                    (
                        "text".to_owned(),
                        flags
                            .value("text")
                            .map(|value| serde_json::Value::String(value.to_owned())),
                    ),
                    (
                        "role".to_owned(),
                        flags
                            .value("role")
                            .map(|value| serde_json::Value::String(value.to_owned())),
                    ),
                    (
                        "limit".to_owned(),
                        optional_number(flags, "limit")?.map(serde_json::Value::Number),
                    ),
                    (
                        "maxDepth".to_owned(),
                        optional_number(flags, "max-depth")?.map(serde_json::Value::Number),
                    ),
                    (
                        "maxNodes".to_owned(),
                        optional_number(flags, "max-nodes")?.map(serde_json::Value::Number),
                    ),
                ]),
            })
        }
        SimVerb::Act => {
            let Some(action) = rest.first() else {
                return Err(usage("ace sim act needs an ACTION."));
            };
            Ok(SimCall {
                verb,
                args: act_args(sim_id, action, &rest[1..], flags)?,
            })
        }
    }
}
