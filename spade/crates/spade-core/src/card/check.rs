//! A card's data against its blocks' rules. Every problem is collected, each at its place, so the
//! bot can fix them all at once.

use serde_json::{Map, Value};

use super::{
    ACTION_CHARS, Action, Block, CELL_CHARS, Card, Field, LABEL_CHARS, MOST_ACTIONS, MOST_BLOCKS,
    MOST_BYTES, MOST_COLUMNS, MOST_FIELDS, MOST_ITEMS, MOST_ROWS, Problem, TITLE_CHARS,
    VALUE_CHARS,
};

/// The card `data` describes, or everything wrong with it.
pub fn check(data: &Value) -> Result<Card, Vec<Problem>> {
    let mut out = Problems::default();
    if data.to_string().len() > MOST_BYTES {
        out.add(
            "data",
            format!("at most {} KiB of data.", MOST_BYTES / 1024),
        );
        return Err(out.0);
    }
    let Some(data) = data.as_object() else {
        out.add("data", "an object: {title, blocks}.".into());
        return Err(out.0);
    };
    out.unknown("data", data, &["title", "blocks"]);
    let title = out.text("data.title", data.get("title"), TITLE_CHARS, true);
    let mut blocks = Vec::new();
    match data.get("blocks") {
        None | Some(Value::Null) => {}
        Some(Value::Array(list)) => {
            if list.len() > MOST_BLOCKS {
                out.add("data.blocks", format!("at most {MOST_BLOCKS} blocks."));
            }
            let actions = list
                .iter()
                .filter(|b| b.get("kind").and_then(Value::as_str) == Some("actions"))
                .count();
            if actions > 1 {
                out.add("data.blocks", "one actions block at most.".into());
            }
            for (i, block) in list.iter().take(MOST_BLOCKS).enumerate() {
                if let Some(block) = out.block(&format!("data.blocks[{i}]"), block) {
                    blocks.push(block);
                }
            }
        }
        Some(_) => out.add("data.blocks", "a list of blocks.".into()),
    }
    let ids: Vec<&str> = blocks
        .iter()
        .flat_map(|b| match b {
            Block::Actions { actions } => actions.as_slice(),
            _ => &[],
        })
        .filter_map(|a| match a {
            Action::Choose { id, .. } => Some(id.as_str()),
            Action::Open { .. } | Action::OpenPanel { .. } => None,
        })
        .collect();
    if ids.iter().enumerate().any(|(i, id)| ids[..i].contains(id)) {
        out.add("data.blocks", "each choice needs its own id.".into());
    }
    match (title, out.0.is_empty()) {
        (Some(title), true) => Ok(Card { title, blocks }),
        _ => Err(out.0),
    }
}

#[derive(Default)]
struct Problems(Vec<Problem>);

impl Problems {
    fn add(&mut self, at: &str, why: String) {
        self.0.push(Problem {
            at: at.to_owned(),
            why,
        });
    }

    /// Fields this kind doesn't have are refused, so a typo is never dropped in silence.
    fn unknown(&mut self, at: &str, object: &Map<String, Value>, known: &[&str]) {
        for key in object.keys().filter(|k| !known.contains(&k.as_str())) {
            self.add(
                &format!("{at}.{key}"),
                format!("not a field here; this takes {}.", known.join(", ")),
            );
        }
    }

    /// Text of at most `most` characters, not blank when `required`.
    fn text(
        &mut self,
        at: &str,
        value: Option<&Value>,
        most: usize,
        required: bool,
    ) -> Option<String> {
        match value {
            None | Some(Value::Null) if !required => None,
            None | Some(Value::Null) => {
                self.add(at, "missing.".into());
                None
            }
            Some(Value::String(text)) => {
                let text = text.trim();
                if text.is_empty() && required {
                    self.add(at, "empty.".into());
                    None
                } else if text.chars().count() > most {
                    self.add(at, format!("at most {most} characters."));
                    None
                } else {
                    Some(text.to_owned())
                }
            }
            // A number reads as its text, so a value can be given as 182 or "182".
            Some(Value::Number(n)) => Some(n.to_string()),
            Some(_) => {
                self.add(at, "text.".into());
                None
            }
        }
    }

    fn texts(
        &mut self,
        at: &str,
        value: Option<&Value>,
        most_items: usize,
        most: usize,
    ) -> Vec<String> {
        match value {
            Some(Value::Array(list)) if list.is_empty() => {
                self.add(at, "at least one.".into());
                Vec::new()
            }
            Some(Value::Array(list)) => {
                if list.len() > most_items {
                    self.add(at, format!("at most {most_items}."));
                }
                list.iter()
                    .take(most_items)
                    .enumerate()
                    .filter_map(|(i, v)| self.text(&format!("{at}[{i}]"), Some(v), most, true))
                    .collect()
            }
            None | Some(Value::Null) => {
                self.add(at, "missing.".into());
                Vec::new()
            }
            Some(_) => {
                self.add(at, "a list.".into());
                Vec::new()
            }
        }
    }

    fn number(&mut self, at: &str, value: Option<&Value>) -> Option<f64> {
        match value.and_then(Value::as_f64).filter(|n| n.is_finite()) {
            Some(n) => Some(n),
            None => {
                self.add(at, "a number.".into());
                None
            }
        }
    }

    /// An https address and its host.
    fn https(&mut self, at: &str, value: Option<&Value>) -> Option<(String, String)> {
        let text = self.text(at, value, 2048, true)?;
        match url::Url::parse(&text) {
            Ok(url) if url.scheme() == "https" && url.host_str().is_some_and(|h| !h.is_empty()) => {
                let host = url.host_str().unwrap_or_default().to_owned();
                Some((url.to_string(), host))
            }
            _ => {
                self.add(at, "an https address.".into());
                None
            }
        }
    }

    fn block(&mut self, at: &str, value: &Value) -> Option<Block> {
        let Some(object) = value.as_object() else {
            self.add(at, "an object with a kind.".into());
            return None;
        };
        let get = |key: &str| object.get(key);
        let kind = object
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let before = self.0.len();
        let block = match kind {
            "fields" => {
                self.unknown(at, object, &["kind", "rows"]);
                let rows = self.list(
                    &format!("{at}.rows"),
                    get("rows"),
                    MOST_FIELDS,
                    |out, at, row| {
                        let row = out.object(at, row, &["label", "value"])?;
                        let label =
                            out.text(&format!("{at}.label"), row.get("label"), LABEL_CHARS, true);
                        let value =
                            out.text(&format!("{at}.value"), row.get("value"), VALUE_CHARS, true);
                        Some(Field {
                            label: label?,
                            value: value?,
                        })
                    },
                );
                Block::Fields { rows }
            }
            "metric" => {
                self.unknown(at, object, &["kind", "label", "value", "unit", "change"]);
                let label = self.text(&format!("{at}.label"), get("label"), LABEL_CHARS, true);
                let value = self.text(&format!("{at}.value"), get("value"), LABEL_CHARS, true);
                let unit = self.text(&format!("{at}.unit"), get("unit"), 20, false);
                let change = self.text(&format!("{at}.change"), get("change"), 20, false);
                Block::Metric {
                    label: label.unwrap_or_default(),
                    value: value.unwrap_or_default(),
                    unit,
                    change,
                }
            }
            "progress" => {
                self.unknown(at, object, &["kind", "label", "value", "max"]);
                let label = self.text(&format!("{at}.label"), get("label"), LABEL_CHARS, false);
                let value = self.number(&format!("{at}.value"), get("value"));
                let max = self.number(&format!("{at}.max"), get("max"));
                if let (Some(value), Some(max)) = (value, max)
                    && (max <= 0.0 || value < 0.0 || value > max)
                {
                    self.add(at, "value runs from 0 to max, and max is above 0.".into());
                }
                Block::Progress {
                    label,
                    value: value.unwrap_or_default(),
                    max: max.unwrap_or(1.0),
                }
            }
            "table" => {
                self.unknown(at, object, &["kind", "columns", "rows"]);
                let columns = self.texts(
                    &format!("{at}.columns"),
                    get("columns"),
                    MOST_COLUMNS,
                    LABEL_CHARS,
                );
                let width = columns.len();
                let rows = self.list(
                    &format!("{at}.rows"),
                    get("rows"),
                    MOST_ROWS,
                    |out, at, row| {
                        let cells = out.texts(at, Some(row), MOST_COLUMNS, CELL_CHARS);
                        if width > 0 && cells.len() != width {
                            out.add(at, format!("{width} cells, one per column."));
                        }
                        Some(cells)
                    },
                );
                Block::Table { columns, rows }
            }
            "list" => {
                self.unknown(at, object, &["kind", "items", "ordered"]);
                let items = self.texts(
                    &format!("{at}.items"),
                    get("items"),
                    MOST_ITEMS,
                    VALUE_CHARS,
                );
                let ordered = match get("ordered") {
                    None | Some(Value::Null) => false,
                    Some(Value::Bool(b)) => *b,
                    Some(_) => {
                        self.add(&format!("{at}.ordered"), "true or false.".into());
                        false
                    }
                };
                Block::List { items, ordered }
            }
            "image" => {
                self.unknown(at, object, &["kind", "file", "alt"]);
                let file = self.text(&format!("{at}.file"), get("file"), 512, true);
                let alt = self.text(&format!("{at}.alt"), get("alt"), VALUE_CHARS, true);
                Block::Image {
                    file: file.unwrap_or_default(),
                    image: None,
                    alt: alt.unwrap_or_default(),
                }
            }
            "link" => {
                self.unknown(at, object, &["kind", "url", "label"]);
                let link = self.https(&format!("{at}.url"), get("url"));
                let label = self.text(&format!("{at}.label"), get("label"), LABEL_CHARS, false);
                let (url, host) = link.unwrap_or_default();
                Block::Link { url, host, label }
            }
            "actions" => {
                self.unknown(at, object, &["kind", "actions"]);
                let actions = self.list(
                    &format!("{at}.actions"),
                    get("actions"),
                    MOST_ACTIONS,
                    Self::action,
                );
                Block::Actions { actions }
            }
            "" => {
                self.add(&format!("{at}.kind"), "missing.".into());
                return None;
            }
            other => {
                self.add(
                    &format!("{at}.kind"),
                    format!(
                        "{other} is not a block; use fields, metric, progress, table, list, \
                         image, link or actions."
                    ),
                );
                return None;
            }
        };
        (self.0.len() == before).then_some(block)
    }

    fn action(&mut self, at: &str, value: &Value) -> Option<Action> {
        let kind = value
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "choose" => {
                let object = self.object(at, value, &["kind", "id", "label"])?;
                let id = self.text(&format!("{at}.id"), object.get("id"), LABEL_CHARS, true);
                let label = self.text(
                    &format!("{at}.label"),
                    object.get("label"),
                    ACTION_CHARS,
                    true,
                );
                Some(Action::Choose {
                    id: id?,
                    label: label?,
                })
            }
            "open" => {
                let object = self.object(at, value, &["kind", "label", "url", "panel"])?;
                let label = self.text(
                    &format!("{at}.label"),
                    object.get("label"),
                    ACTION_CHARS,
                    true,
                );
                // A panel of the bot's package, by id; the engine checks the bot ships it.
                if let Some(panel) = object.get("panel") {
                    let panel = match panel.as_str() {
                        Some(id) if object.get("url").is_none() && !id.trim().is_empty() => {
                            Some(id.trim().to_owned())
                        }
                        _ => {
                            self.add(
                                &format!("{at}.panel"),
                                "names one of your panels by id, instead of a url.".into(),
                            );
                            None
                        }
                    };
                    return Some(Action::OpenPanel {
                        label: label?,
                        panel: panel?,
                    });
                }
                let link = self.https(&format!("{at}.url"), object.get("url"));
                let (url, host) = link?;
                Some(Action::Open {
                    label: label?,
                    url,
                    host,
                })
            }
            _ => {
                self.add(&format!("{at}.kind"), "choose or open.".into());
                None
            }
        }
    }

    fn object<'v>(
        &mut self,
        at: &str,
        value: &'v Value,
        known: &[&str],
    ) -> Option<&'v Map<String, Value>> {
        match value.as_object() {
            Some(object) => {
                self.unknown(at, object, known);
                Some(object)
            }
            None => {
                self.add(at, "an object.".into());
                None
            }
        }
    }

    /// A list of one to `most` items, each read by `item`.
    fn list<T>(
        &mut self,
        at: &str,
        value: Option<&Value>,
        most: usize,
        mut item: impl FnMut(&mut Self, &str, &Value) -> Option<T>,
    ) -> Vec<T> {
        match value {
            Some(Value::Array(list)) if !list.is_empty() => {
                if list.len() > most {
                    self.add(at, format!("at most {most}."));
                }
                list.iter()
                    .take(most)
                    .enumerate()
                    .filter_map(|(i, v)| item(self, &format!("{at}[{i}]"), v))
                    .collect()
            }
            Some(Value::Array(_)) => {
                self.add(at, "at least one.".into());
                Vec::new()
            }
            None | Some(Value::Null) => {
                self.add(at, "missing.".into());
                Vec::new()
            }
            Some(_) => {
                self.add(at, "a list.".into());
                Vec::new()
            }
        }
    }
}
