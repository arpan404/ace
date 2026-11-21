//! A form an app's server asks the person to fill in mid-call (MCP elicitation, form mode; ADR
//! 0202 §2), as a question card from the bot labelled with the app's name. The card is the
//! person's alone: only an answer they give on it goes back to the app, never a message they
//! type, and it closes when the call it belongs to ends. A form that asks for a secret (a
//! password, a token, a card number) is never shown: the call fails with [`SECRET`].
//!
//! Pure: the engine stores the card and hands the answer back to the call that waits on it.

use serde_json::{Map, Value};

use super::{
    Choice, Kind, LABEL_CHARS, LEAST_OPTIONS, MOST_OPTIONS, MOST_QUESTIONS, PROMPT_CHARS, Question,
};

/// What a call whose app asked for a secret reads.
pub const SECRET: &str = "It asked for a secret in chat";

/// Between a call's id and its form's number, in the card's id.
const MARK: &str = "~form";

/// The id of the card for the `n`th form the call `call_id` showed. Apart from the call's own
/// id, so the call keeps running while its card waits.
pub fn card_id(call_id: &str, n: usize) -> String {
    format!("{call_id}{MARK}{n}")
}

/// The call a form's card belongs to; `None` for any other card.
pub fn call_of(card_id: &str) -> Option<&str> {
    let (call, n) = card_id.rsplit_once(MARK)?;
    (!call.is_empty() && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())).then_some(call)
}

/// Why a form isn't shown: the server is answered `decline`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// It asks for a password, a token, a card number or the like.
    Secret,
    /// A field this card can't ask, as the line says.
    Unreadable(&'static str),
}

/// A form as a card: the line `question_asked.question` keeps, and its questions, one per field
/// (each with the field's name as its id).
#[derive(Debug, Clone, PartialEq)]
pub struct Card {
    pub summary: String,
    pub questions: Vec<Question>,
}

/// The card for a form `app` sent, with `message` and `schema` (its `requestedSchema`).
pub fn card(app: &str, message: &str, schema: &Value) -> Result<Card, Refused> {
    if asks_for_secret(message, schema) {
        return Err(Refused::Secret);
    }
    let summary = clip(&format!("{app} asks: {}", message.trim()), PROMPT_CHARS);
    let fields = schema
        .get("properties")
        .map(|p| {
            p.as_object()
                .ok_or(Refused::Unreadable("its fields aren't a list"))
        })
        .transpose()?;
    let fields: Vec<(&String, &Value)> = fields.map(|f| f.iter().collect()).unwrap_or_default();
    if fields.is_empty() {
        // Nothing to fill in: the person goes ahead or not.
        return Ok(Card {
            questions: vec![Question {
                id: None,
                prompt: summary.clone(),
                kind: Kind::Confirm {},
            }],
            summary,
        });
    }
    if fields.len() > MOST_QUESTIONS {
        return Err(Refused::Unreadable(
            "it asks for more than five things at once",
        ));
    }
    let mut questions = Vec::with_capacity(fields.len());
    for (at, (name, spec)) in fields.into_iter().enumerate() {
        let label = label_of(name, spec);
        let prompt = if at == 0 {
            format!("{summary}\n\n{label}")
        } else {
            label
        };
        questions.push(Question {
            id: Some(name.clone()),
            prompt: clip(&prompt, PROMPT_CHARS),
            kind: kind(spec)?,
        });
    }
    Ok(Card { summary, questions })
}

/// What the person's answers on the card send back to the app.
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    /// The form's content, by field name, typed as its schema asks.
    Accept(Map<String, Value>),
    /// A form with nothing to fill in, which they didn't go ahead with.
    Decline,
}

/// The app's answer for `answers` (checked against `questions`, the card [`card`] made for
/// `schema`).
pub fn answer(schema: &Value, questions: &[Question], answers: &[Value]) -> Answer {
    if let [only] = questions
        && only.id.is_none()
    {
        return match answers.first() {
            Some(Value::Bool(true)) => Answer::Accept(Map::new()),
            _ => Answer::Decline,
        };
    }
    let mut content = Map::new();
    for (question, given) in questions.iter().zip(answers) {
        let Some(name) = &question.id else { continue };
        let spec = &schema["properties"][name];
        content.insert(name.clone(), value(spec, given));
    }
    Answer::Accept(content)
}

/// `given` as the field asks for it: an option's own value for its label, an integer for a
/// whole number in an integer field.
fn value(spec: &Value, given: &Value) -> Value {
    match (spec.get("type").and_then(Value::as_str), given) {
        (Some("integer"), Value::Number(n)) => n
            .as_f64()
            .filter(|f| f.fract() == 0.0 && f.abs() < 9.0e15)
            .map_or_else(|| given.clone(), |f| Value::from(f as i64)),
        (Some("string"), Value::String(label)) => Value::String(option_value(spec, label)),
        (Some("array"), Value::Array(labels)) => Value::Array(
            labels
                .iter()
                .map(|label| match label.as_str() {
                    Some(label) => Value::String(option_value(&spec["items"], label)),
                    None => label.clone(),
                })
                .collect(),
        ),
        _ => given.clone(),
    }
}

/// The value an option with `label` stands for: a `oneOf`/`anyOf` entry's `const`, else the label.
fn option_value(spec: &Value, label: &str) -> String {
    options_of(spec)
        .and_then(|options| {
            options
                .into_iter()
                .find(|(shown, _)| shown == label)
                .map(|(_, value)| value)
        })
        .unwrap_or_else(|| label.to_owned())
}

fn kind(spec: &Value) -> Result<Kind, Refused> {
    let unreadable = Refused::Unreadable("it asks for something a card can't hold");
    match spec.get("type").and_then(Value::as_str) {
        Some("string") => {
            if let Some(options) = options_of(spec) {
                return Ok(Kind::Choice {
                    options: choices(options)?,
                    other: false,
                });
            }
            Ok(match spec.get("format").and_then(Value::as_str) {
                Some("date") => Kind::Date { time: false },
                Some("date-time") => Kind::Date { time: true },
                _ => Kind::Text {
                    placeholder: spec
                        .get("description")
                        .and_then(Value::as_str)
                        .map(|d| clip(d, LABEL_CHARS)),
                },
            })
        }
        Some("number" | "integer") => Ok(Kind::Number {
            min: spec.get("minimum").and_then(Value::as_f64),
            max: spec.get("maximum").and_then(Value::as_f64),
            unit: None,
        }),
        Some("boolean") => Ok(Kind::Confirm {}),
        Some("array") => {
            let options = options_of(&spec["items"]).ok_or(unreadable)?;
            let count = |key: &str| {
                spec.get(key)
                    .and_then(Value::as_u64)
                    .and_then(|n| usize::try_from(n).ok())
            };
            Ok(Kind::Choices {
                options: choices(options)?,
                min: count("minItems"),
                max: count("maxItems"),
                other: false,
            })
        }
        _ => Err(unreadable),
    }
}

/// A field's options as (label shown, value sent): `enum` values, or `oneOf`/`anyOf` entries
/// with a `const` and maybe a `title`.
fn options_of(spec: &Value) -> Option<Vec<(String, String)>> {
    if let Some(values) = spec.get("enum").and_then(Value::as_array) {
        return values
            .iter()
            .map(|v| v.as_str().map(|v| (v.to_owned(), v.to_owned())))
            .collect();
    }
    let entries = spec
        .get("oneOf")
        .or_else(|| spec.get("anyOf"))
        .and_then(Value::as_array)?;
    entries
        .iter()
        .map(|entry| {
            let value = entry.get("const")?.as_str()?.to_owned();
            let label = entry
                .get("title")
                .and_then(Value::as_str)
                .map_or_else(|| value.clone(), str::to_owned);
            Some((label, value))
        })
        .collect()
}

fn choices(options: Vec<(String, String)>) -> Result<Vec<Choice>, Refused> {
    if !(LEAST_OPTIONS..=MOST_OPTIONS).contains(&options.len()) {
        return Err(Refused::Unreadable("its choices are too few or too many"));
    }
    let mut seen = std::collections::HashSet::new();
    options
        .into_iter()
        .map(|(label, _)| {
            let label = clip(&label, LABEL_CHARS);
            if seen.insert(label.clone()) {
                Ok(Choice {
                    label,
                    detail: None,
                })
            } else {
                Err(Refused::Unreadable("two of its choices read the same"))
            }
        })
        .collect()
}

/// What a field is called on the card: its title, else its description, else its name.
fn label_of(name: &str, spec: &Value) -> String {
    ["title", "description"]
        .iter()
        .find_map(|key| spec.get(*key).and_then(Value::as_str))
        .filter(|label| !label.trim().is_empty())
        .unwrap_or(name)
        .trim()
        .to_owned()
}

/// Words that name a secret, whole (`pin`) or run together (`apikey`, `cardnumber`).
const SECRET_WORDS: &[&str] = &[
    "password",
    "passwd",
    "passcode",
    "passphrase",
    "token",
    "secret",
    "apikey",
    "privatekey",
    "credential",
    "credentials",
    "otp",
    "cardnumber",
    "creditcard",
    "debitcard",
    "cvv",
    "cvc",
    "securitycode",
    "ssn",
];

/// Short words that name a secret only as a field's own name or title (`pin`), not in the
/// server's message, where they mean other things.
const FIELD_WORDS: &[&str] = &["pin", "pwd", "mfa", "totp"];

/// Whether a form asks for a secret: a field marked as one (`format: password`, `writeOnly`), or
/// a word for one in its message or in a field's name, title or description.
pub fn asks_for_secret(message: &str, schema: &Value) -> bool {
    let Some(fields) = schema.get("properties").and_then(Value::as_object) else {
        return names_secret(message, false);
    };
    names_secret(message, false)
        || fields.iter().any(|(name, spec)| {
            spec.get("format").and_then(Value::as_str) == Some("password")
                || spec.get("writeOnly").and_then(Value::as_bool) == Some(true)
                || names_secret(name, true)
                || ["title", "description"].iter().any(|key| {
                    spec.get(*key)
                        .and_then(Value::as_str)
                        .is_some_and(|text| names_secret(text, true))
                })
        })
}

/// Whether `text` says a secret's word: alone, or with its neighbours run together (`api key`,
/// `api_key` and `apiKey` all read `apikey`).
fn names_secret(text: &str, field: bool) -> bool {
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut last_lower = false;
    for c in text.chars() {
        if c.is_alphanumeric() {
            // camelCase splits too: `apiKey` is `api key`.
            if c.is_uppercase() && last_lower {
                words.push(std::mem::take(&mut word));
            }
            last_lower = c.is_lowercase();
            word.extend(c.to_lowercase());
        } else {
            last_lower = false;
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
        }
    }
    if !word.is_empty() {
        words.push(word);
    }
    let secret = |w: &str| SECRET_WORDS.contains(&w) || (field && FIELD_WORDS.contains(&w));
    words.iter().any(|w| secret(w))
        || words.windows(2).any(|pair| secret(&pair.concat()))
        || words.windows(3).any(|three| secret(&three.concat()))
}

fn clip(text: &str, most: usize) -> String {
    text.chars().take(most).collect()
}

#[cfg(test)]
mod tests;
