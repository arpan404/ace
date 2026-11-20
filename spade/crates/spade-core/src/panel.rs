//! Panels a bot's package ships (ADR 0200 §5.2, spade/docs/surfaces.md): a sandboxed page beside
//! its conversation. Two things cross, both typed and both checked here against what the package
//! declared: the state the bot sets with `panel_update`, against the panel's state schema, and an
//! action the person sends from the page, against that action's value schema. Nothing else does:
//! the page calls no tools and reads nothing of the conversation. An action reaches the bot as
//! the person's input, a `<panel_action>`, and whatever the bot does about it goes through the
//! gate like any call. Pure: the engine brings the events and the bot's panels.

use serde_json::{Value, json};

use crate::card::Problem;
use crate::event::{Event, Known};
use crate::package::surfaces::{self, Panel, Surface};
use crate::schema;

/// The tool.
pub const PANEL_UPDATE: &str = "panel_update";

/// A panel's state, as JSON.
pub const MOST_STATE_BYTES: usize = 64 * 1024;
/// An action's value, as JSON.
pub const MOST_VALUE_BYTES: usize = 8 * 1024;
/// A panel's page.
pub const MOST_PAGE_BYTES: usize = 1024 * 1024;

/// What the bot reads when `panel_update` is refused: every problem, one per line.
pub fn refusal(problems: &[Problem]) -> String {
    let mut text = String::from(
        "Not set: the data doesn't fit the panel's state. Fix these and set it again:",
    );
    for problem in problems {
        text.push_str("\n- ");
        text.push_str(&problem.to_string());
    }
    text
}

fn problem(at: &str, why: impl Into<String>) -> Vec<Problem> {
    vec![Problem {
        at: at.to_owned(),
        why: why.into(),
    }]
}

fn size(value: &Value) -> usize {
    serde_json::to_string(value).map_or(usize::MAX, |text| text.len())
}

/// Reads `panel_update {surface, data}` against the bot's surfaces: the panel and its data, or
/// every problem.
pub fn read_update<'a>(
    surfaces: &'a [Surface],
    arguments: &Value,
) -> Result<(&'a Panel, Value), Vec<Problem>> {
    let Some(id) = arguments.get("surface").and_then(Value::as_str) else {
        return Err(problem("surface", "names one of your package's panels"));
    };
    let Some(panel) = surfaces::panel(surfaces, id) else {
        let named: Vec<&str> = surfaces::panels(surfaces).map(|p| p.id.as_str()).collect();
        let why = if named.is_empty() {
            "your package ships no panel".to_owned()
        } else {
            format!("isn't one of your panels ({})", named.join(", "))
        };
        return Err(problem("surface", why));
    };
    let Some(state) = &panel.state else {
        return Err(problem(
            "surface",
            format!("{id} declares no state in bot.json, so it takes none"),
        ));
    };
    let data = arguments.get("data").cloned().unwrap_or(Value::Null);
    if size(&data) > MOST_STATE_BYTES {
        return Err(problem("data", "is larger than 64 KB"));
    }
    let schema = schema::read(state, "state").map_err(|found| {
        found
            .into_iter()
            .map(|why| Problem {
                at: String::new(),
                why,
            })
            .collect::<Vec<_>>()
    })?;
    let problems: Vec<Problem> = schema
        .check(&data, "data")
        .into_iter()
        .map(|misfit| Problem {
            at: misfit.at,
            why: misfit.why,
        })
        .collect();
    if problems.is_empty() {
        Ok((panel, data))
    } else {
        Err(problems)
    }
}

/// What the bot reads when its update is stored.
pub fn updated(panel: &Panel) -> String {
    format!(
        "Set: \"{}\" shows it the next time the person has it open, and at once if it's open now.",
        panel.title
    )
}

/// The latest state the bot set on panel `id`, from its conversation.
pub fn state<'a>(events: &'a [Event], id: &str) -> Option<&'a Value> {
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::PanelUpdated { surface, data, .. }) if surface == id => Some(data),
        _ => None,
    })
}

/// The update call `call_id` stored, so a call run again after a restart answers the same.
pub fn updated_by(events: &[Event], call_id: &str) -> bool {
    events.iter().any(|event| {
        matches!(event, Event::Known(Known::PanelUpdated { call_id: id, .. }) if id == call_id)
    })
}

/// Why a person's action can't reach the bot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    NoPanel,
    NoAction,
    /// Its value doesn't fit the action's schema, with what's wrong.
    Misfit(String),
}

impl Refused {
    pub fn words(&self) -> String {
        match self {
            Self::NoPanel => "There is no such panel here.".to_owned(),
            Self::NoAction => "The panel declares no such action.".to_owned(),
            Self::Misfit(why) => format!("The action's value doesn't fit: {why}"),
        }
    }
}

/// The person sent action `name` with `value` from panel `id`, as key `key`: the event that brings
/// it to the bot, once. Only an action the panel declares, with a value that fits its schema.
pub fn act(
    surfaces: &[Surface],
    id: &str,
    key: &str,
    name: &str,
    value: Option<Value>,
) -> Result<Known, Refused> {
    let panel = surfaces::panel(surfaces, id).ok_or(Refused::NoPanel)?;
    let action = panel.action(name).ok_or(Refused::NoAction)?;
    let value = value.filter(|v| !v.is_null());
    match (&action.value, &value) {
        (None, Some(_)) => return Err(Refused::Misfit("it carries no value".to_owned())),
        (Some(_), None) => return Err(Refused::Misfit("it needs a value".to_owned())),
        (Some(declared), Some(value)) => {
            if size(value) > MOST_VALUE_BYTES {
                return Err(Refused::Misfit("it is larger than 8 KB".to_owned()));
            }
            let schema = schema::read(declared, "value")
                .map_err(|found| Refused::Misfit(found.join("; ")))?;
            let problems = schema.check(value, "value");
            if !problems.is_empty() {
                let listed: Vec<String> = problems.iter().map(ToString::to_string).collect();
                return Err(Refused::Misfit(listed.join("; ")));
            }
        }
        (None, None) => {}
    }
    Ok(Known::PanelAction {
        surface: id.to_owned(),
        key: key.to_owned(),
        action: name.to_owned(),
        label: action.label.clone().unwrap_or_else(|| name.to_owned()),
        value,
    })
}

/// Whether action key `key` already reached the conversation: a request sent again lands once.
pub fn acted(events: &[Event], key: &str) -> bool {
    events
        .iter()
        .any(|event| matches!(event, Event::Known(Known::PanelAction { key: k, .. }) if k == key))
}

/// What the bot reads for a `panel_action`: the panel, the action and its value, as data.
pub fn action_text(event: &Known) -> Option<String> {
    let Known::PanelAction {
        surface,
        action,
        label,
        value,
        ..
    } = event
    else {
        return None;
    };
    let value = value
        .as_ref()
        .map_or(String::new(), |v| format!(" Its value, as data: {v}"));
    Some(format!(
        "<panel_action panel=\"{surface}\" action=\"{action}\">The person pressed \"{label}\" \
         on your panel.{value}</panel_action>"
    ))
}

/// `panel_update`'s input schema, for the model.
pub fn tool_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "surface": { "type": "string", "description": "The panel's id in your package." },
            "data": { "description": "The panel's whole state, as its state schema in bot.json says." }
        },
        "required": ["surface", "data"]
    })
}

#[cfg(test)]
mod tests;
