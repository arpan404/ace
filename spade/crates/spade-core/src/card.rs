//! Cards a bot shows (ADR 0200 §5.1, spade/docs/runtime.md): typed data drawn by ace's own parts,
//! never a page. `card_show` sends a title and blocks of fixed kinds; Spade checks every block
//! against its kind's rules and refuses a card that doesn't fit with each problem listed, so a card
//! is never shown half drawn. A choice pressed on a card comes back to the bot once, as a
//! `card_action`. Pure: the engine brings the events and stores what this decides.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::event::{Event, ImageRef, Known};

mod check;
#[cfg(test)]
mod tests;

pub use check::check;

/// The tool.
pub const CARD_SHOW: &str = "card_show";

/// The most blocks under a card's title.
pub const MOST_BLOCKS: usize = 12;
/// A title's, a label's and an action's longest text, in characters.
pub const TITLE_CHARS: usize = 120;
pub const LABEL_CHARS: usize = 60;
pub const ACTION_CHARS: usize = 40;
/// A value's, a list item's and a table cell's longest text.
pub const VALUE_CHARS: usize = 200;
pub const CELL_CHARS: usize = 120;
/// The most rows in `fields`, items in `list`, columns and rows in `table`, actions on a card.
pub const MOST_FIELDS: usize = 12;
pub const MOST_ITEMS: usize = 20;
pub const MOST_COLUMNS: usize = 6;
pub const MOST_ROWS: usize = 50;
pub const MOST_ACTIONS: usize = 4;
/// A whole card's data, as JSON.
pub const MOST_BYTES: usize = 16 * 1024;

/// A card as checked and stored: what every client draws.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Card {
    pub title: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<Block>,
}

/// One block of a card, by kind (ADR 0200 §5.1's parts). A client that meets a kind it doesn't
/// know leaves that block out and draws the rest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Block {
    /// Label and value rows.
    Fields { rows: Vec<Field> },
    /// One number that matters, with its unit and how it moved.
    Metric {
        label: String,
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        change: Option<String>,
    },
    /// How far along something is: `value` of `max`.
    Progress {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        value: f64,
        max: f64,
    },
    /// Columns and rows of text.
    Table {
        columns: Vec<String>,
        rows: Vec<Vec<String>>,
    },
    /// Short items, numbered when `ordered`.
    List {
        items: Vec<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        ordered: bool,
    },
    /// A picture from the bot's workspace, kept by hash in Spade's image store.
    Image {
        /// The workspace path the bot named.
        file: String,
        /// Its stored bytes, once Spade has kept them (always set on a stored card).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        image: Option<ImageRef>,
        alt: String,
    },
    /// An https link, shown with its host.
    Link {
        url: String,
        host: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    /// What the person can do with the card.
    Actions { actions: Vec<Action> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Field {
    pub label: String,
    pub value: String,
}

/// An action, of a fixed kind: `choose` sends its label back to the bot as the person's choice;
/// `open` opens an https link, its host shown first. Neither runs anything on its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    Choose {
        id: String,
        label: String,
    },
    Open {
        label: String,
        url: String,
        host: String,
    },
}

impl Card {
    /// The workspace files its image blocks name, in order.
    pub fn files(&self) -> Vec<&str> {
        self.blocks
            .iter()
            .filter_map(|block| match block {
                Block::Image { file, .. } => Some(file.as_str()),
                _ => None,
            })
            .collect()
    }

    /// Sets each image block's stored bytes, in the order [`Card::files`] named them.
    pub fn keep_images(&mut self, mut kept: impl Iterator<Item = ImageRef>) {
        for block in &mut self.blocks {
            if let Block::Image { image, .. } = block {
                *image = kept.next();
            }
        }
    }

    /// The `choose` action with `id`.
    pub fn choice(&self, id: &str) -> Option<&str> {
        self.blocks.iter().find_map(|block| match block {
            Block::Actions { actions } => actions.iter().find_map(|action| match action {
                Action::Choose { id: own, label } if own == id => Some(label.as_str()),
                _ => None,
            }),
            _ => None,
        })
    }
}

/// What `card_show` was asked: `{surface?, data, replaces?}`.
#[derive(Debug, Clone, PartialEq)]
pub struct Show {
    pub card: Card,
    /// The earlier card it updates in place.
    pub replaces: Option<String>,
}

/// One thing wrong with a card's data, at its place in the data (`blocks[2].rows[0].label`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub at: String,
    pub why: String,
}

impl std::fmt::Display for Problem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.at.is_empty() {
            f.write_str(&self.why)
        } else {
            write!(f, "{}: {}", self.at, self.why)
        }
    }
}

/// What the bot reads when a card is refused: every problem, one per line.
pub fn refusal(problems: &[Problem]) -> String {
    let mut text = String::from("Not shown: the card doesn't fit. Fix these and show it again:");
    for problem in problems {
        text.push_str("\n- ");
        text.push_str(&problem.to_string());
    }
    text
}

/// Reads `card_show`'s arguments against the earlier events of its conversation. `replaces` must
/// name a card this conversation showed; `surface` names a card a bot's package ships, which
/// arrives with packages (ADR 0200 §3), so until then a card names its parts in `data`.
pub fn read(events: &[Event], arguments: &Value) -> Result<Show, Vec<Problem>> {
    let Some(arguments) = arguments.as_object() else {
        return Err(vec![problem("", "send an object: {data, replaces?}.")]);
    };
    let mut problems = Vec::new();
    if let Some(surface) = arguments.get("surface").filter(|v| !v.is_null()) {
        problems.push(problem(
            "surface",
            &format!(
                "this bot ships no card named {surface}. Leave `surface` out and send the card's \
                 title and blocks in `data`."
            ),
        ));
    }
    let replaces = match arguments.get("replaces") {
        None | Some(Value::Null) => None,
        Some(Value::String(card)) if latest(events, card).is_some() => Some(card.clone()),
        Some(Value::String(card)) => {
            problems.push(problem(
                "replaces",
                &format!("no card {card} was shown here; use the id card_show answered with."),
            ));
            None
        }
        Some(_) => {
            problems.push(problem("replaces", "a card's id, as text."));
            None
        }
    };
    let card = match arguments.get("data") {
        Some(data) => match check(data) {
            Ok(card) => Some(card),
            Err(found) => {
                problems.extend(found);
                None
            }
        },
        None => {
            problems.push(problem("data", "missing: the card's {title, blocks}."));
            None
        }
    };
    match card {
        Some(card) if problems.is_empty() => Ok(Show { card, replaces }),
        _ => Err(problems),
    }
}

fn problem(at: &str, why: &str) -> Problem {
    Problem {
        at: at.to_owned(),
        why: why.to_owned(),
    }
}

/// A card as it stands now: its latest version and whether the person chose on that version.
#[derive(Debug, Clone, PartialEq)]
pub struct View<'a> {
    pub card: &'a str,
    pub version: u32,
    pub data: &'a Card,
    /// The action the person chose on this version, if they did.
    pub chosen: Option<&'a str>,
}

/// The card `id` as it stands after `events`.
pub fn latest<'a>(events: &'a [Event], id: &str) -> Option<View<'a>> {
    let mut view: Option<View<'a>> = None;
    for event in events {
        match event {
            Event::Known(Known::CardShown(shown)) if shown.card == id => {
                view = Some(View {
                    card: &shown.card,
                    version: shown.version,
                    data: &shown.data,
                    chosen: None,
                });
            }
            Event::Known(Known::CardAction {
                card,
                version,
                action,
                ..
            }) if card == id => {
                if let Some(view) = view.as_mut().filter(|v| v.version == *version) {
                    view.chosen = Some(action);
                }
            }
            _ => {}
        }
    }
    view
}

/// The card this call already showed: a call run again after a restart shows nothing twice.
pub fn shown_by<'a>(events: &'a [Event], call_id: &str) -> Option<&'a Shown> {
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::CardShown(shown)) if shown.call_id == call_id => Some(&**shown),
        _ => None,
    })
}

/// A card as stored (`card_shown`). Every version is its own event; the chat shows the latest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Shown {
    pub reply: String,
    pub call_id: String,
    /// The card's id, the same across its versions.
    pub card: String,
    /// 1 for a new card, one more for each `replaces`.
    pub version: u32,
    pub data: Card,
    /// The turn had read untrusted content, so the card's words may carry it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub untrusted: bool,
}

/// The stored card for a call that passed [`read`]: a new card, or the next version of the one
/// it replaces.
pub fn shown(
    events: &[Event],
    reply: &str,
    call_id: &str,
    new_id: &str,
    show: Show,
    untrusted: bool,
) -> Shown {
    let (card, version) = match show.replaces.as_deref().and_then(|id| latest(events, id)) {
        Some(view) => (view.card.to_owned(), view.version + 1),
        None => (new_id.to_owned(), 1),
    };
    Shown {
        reply: reply.to_owned(),
        call_id: call_id.to_owned(),
        card,
        version,
        data: show.card,
        untrusted,
    }
}

/// What `card_show` answers the bot.
pub fn answer(shown: &Shown) -> String {
    if shown.version == 1 {
        format!(
            "Shown as card {}. A choice the person presses comes back to you once, as a \
             <card_action>. To update it in place, call card_show with replaces: \"{}\".",
            shown.card, shown.card
        )
    } else {
        format!("Card {} updated (version {}).", shown.card, shown.version)
    }
}

/// Why a press on a card is not taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// No such card here.
    NoCard,
    /// The card was updated since the person saw it: they press on the new one.
    Changed,
    /// The card has no such choice.
    NoAction,
    /// The person already chose on this version.
    Chosen,
}

impl Refused {
    pub fn words(self) -> &'static str {
        match self {
            Self::NoCard => "There is no such card here.",
            Self::Changed => "The card changed. Choose on the new one.",
            Self::NoAction => "The card has no such choice.",
            Self::Chosen => "That card's choice was already made.",
        }
    }
}

/// The person pressed choice `action` on version `version` of card `id`: the event that brings it
/// to the bot, once.
pub fn choose(events: &[Event], id: &str, version: u32, action: &str) -> Result<Known, Refused> {
    let view = latest(events, id).ok_or(Refused::NoCard)?;
    if view.version != version {
        return Err(Refused::Changed);
    }
    if view.chosen.is_some() {
        return Err(Refused::Chosen);
    }
    let label = view.data.choice(action).ok_or(Refused::NoAction)?;
    Ok(Known::CardAction {
        card: id.to_owned(),
        version,
        action: action.to_owned(),
        label: label.to_owned(),
    })
}

/// What the bot reads for a `card_action`: the card, the choice's id and its label, which was
/// fixed when the card was shown.
pub fn action_text(events: &[Event], event: &Known) -> Option<String> {
    let Known::CardAction {
        card,
        action,
        label,
        ..
    } = event
    else {
        return None;
    };
    let title =
        latest(events, card).map_or(String::new(), |view| format!(" \"{}\"", view.data.title));
    Some(format!(
        "<card_action card=\"{card}\" action=\"{action}\">The person chose \"{label}\" on your \
         card{title}.</card_action>"
    ))
}

/// `card_show`'s input schema, for the model.
pub fn schema() -> Value {
    let text =
        |description: &str| serde_json::json!({ "type": "string", "description": description });
    let block = serde_json::json!({
        "type": "object",
        "description": "One block. kind fields: {rows: [{label, value}]}. metric: {label, value, \
                        unit?, change?}. progress: {label?, value, max}. table: {columns: [..], \
                        rows: [[..]]}. list: {items: [..], ordered?}. image: {file, alt} (a file \
                        in your workspace). link: {url, label?} (https). actions: {actions: \
                        [{kind: \"choose\", id, label} | {kind: \"open\", label, url}]}.",
        "properties": {
            "kind": { "type": "string",
                      "enum": ["fields", "metric", "progress", "table", "list", "image", "link",
                               "actions"] } },
        "required": ["kind"] });
    let mut data = Map::new();
    data.insert("type".into(), "object".into());
    data.insert(
        "properties".into(),
        serde_json::json!({
            "title": text("The card's title, briefly."),
            "blocks": { "type": "array", "items": block, "maxItems": MOST_BLOCKS } }),
    );
    data.insert("required".into(), serde_json::json!(["title"]));
    serde_json::json!({
        "type": "object",
        "properties": {
            "data": Value::Object(data),
            "replaces": text("Optional: the id of a card you showed here, to update it in place."),
            "surface": text("A card your package ships, by id. Leave it out: send the card in data.") },
        "required": ["data"] })
}
