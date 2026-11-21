//! The checks on `ask_user`'s arguments and on the person's answers. Every refusal says which
//! rule, so the bot (or the card) can fix it.

use serde_json::{Map, Value};

use super::{
    ANSWER_CHARS, Ask, Choice, DETAIL_CHARS, Kind, LABEL_CHARS, LEAST_OPTIONS, MOST_OPTIONS,
    MOST_QUESTIONS, PROMPT_CHARS, Question, object,
};

const KINDS: &str = "text, choice, choices, confirm, number or date";
const ID_CHARS: usize = 64;
const SHORT_CHARS: usize = 200;

/// The questions an `ask_user` call asks, or why it can't ask them. Takes `questions` (one to
/// five), or the old `question` as one `text` question, and `wait` (default `true`).
pub fn parse(arguments: &Value) -> Result<Ask, String> {
    let wait = match arguments.get("wait") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(wait)) => *wait,
        Some(_) => return Err("`wait` must be true or false.".to_owned()),
    };
    let questions = match (arguments.get("questions"), arguments.get("question")) {
        (Some(Value::Array(list)), _) => {
            if list.is_empty() || list.len() > MOST_QUESTIONS {
                return Err(format!(
                    "Ask 1 to {MOST_QUESTIONS} questions in `questions`; this call has {}.",
                    list.len()
                ));
            }
            let mut questions = Vec::with_capacity(list.len());
            for (at, raw) in list.iter().enumerate() {
                let question = one(raw).map_err(|why| format!("Question {}: {why}", at + 1))?;
                questions.push(question);
            }
            questions
        }
        (Some(_), _) => return Err("`questions` must be a list of questions.".to_owned()),
        (None, Some(Value::String(text))) => vec![Question {
            id: None,
            prompt: prompt(text)?,
            kind: Kind::Text { placeholder: None },
        }],
        (None, _) => {
            return Err(
                "Give the questions to ask in `questions`, each with `prompt` and `kind`."
                    .to_owned(),
            );
        }
    };
    let mut ids: Vec<&str> = Vec::new();
    for question in &questions {
        if let Some(id) = &question.id {
            if ids.contains(&id.as_str()) {
                return Err(format!(
                    "Two questions have the id \"{id}\"; make each unique."
                ));
            }
            ids.push(id);
        }
    }
    Ok(Ask { questions, wait })
}

fn one(raw: &Value) -> Result<Question, String> {
    let Some(fields) = object(raw) else {
        return Err("each question is an object with `prompt` and `kind`.".to_owned());
    };
    let kind_name = match fields.get("kind") {
        Some(Value::String(kind)) => kind.as_str(),
        Some(_) | None => return Err(format!("give a `kind`: {KINDS}.")),
    };
    let allowed: &[&str] = match kind_name {
        "text" => &["placeholder"],
        "choice" => &["options", "other"],
        "choices" => &["options", "min", "max", "other"],
        "confirm" => &[],
        "number" => &["min", "max", "unit"],
        "date" => &["time"],
        other => return Err(format!("there is no kind \"{other}\"; use {KINDS}.")),
    };
    for key in fields.keys() {
        if !["id", "prompt", "kind"].contains(&key.as_str()) && !allowed.contains(&key.as_str()) {
            let fields = if allowed.is_empty() {
                "none of its own".to_owned()
            } else {
                allowed.join(", ")
            };
            return Err(format!(
                "a {kind_name} question has no field `{key}` (its fields: id, prompt, kind and \
                 {fields})."
            ));
        }
    }
    let id = match fields.get("id") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) if !id.trim().is_empty() && id.chars().count() <= ID_CHARS => {
            Some(id.trim().to_owned())
        }
        Some(_) => {
            return Err(format!(
                "`id` is a short text, up to {ID_CHARS} characters."
            ));
        }
    };
    let prompt = match fields.get("prompt") {
        Some(Value::String(text)) => prompt(text)?,
        _ => return Err("give the question's `prompt`, briefly.".to_owned()),
    };
    let kind = match kind_name {
        "text" => Kind::Text {
            placeholder: short(fields, "placeholder")?,
        },
        "choice" => Kind::Choice {
            options: options(fields)?,
            other: flag(fields, "other")?,
        },
        "choices" => {
            let options = options(fields)?;
            let other = flag(fields, "other")?;
            let most = options.len() + usize::from(other);
            let min = count(fields, "min")?;
            let max = count(fields, "max")?;
            if let Some(max) = max
                && (max == 0 || max > most)
            {
                return Err(format!("`max` must be 1 to {most}."));
            }
            if min.unwrap_or(1) > max.unwrap_or(most) {
                return Err("`min` is more than `max`.".to_owned());
            }
            Kind::Choices {
                options,
                min,
                max,
                other,
            }
        }
        "confirm" => Kind::Confirm {},
        "number" => {
            let min = number(fields, "min")?;
            let max = number(fields, "max")?;
            if let (Some(min), Some(max)) = (min, max)
                && min > max
            {
                return Err("`min` is more than `max`.".to_owned());
            }
            Kind::Number {
                min,
                max,
                unit: short(fields, "unit")?,
            }
        }
        _ => Kind::Date {
            time: flag(fields, "time")?,
        },
    };
    Ok(Question { id, prompt, kind })
}

fn prompt(text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("give the question's `prompt`, briefly.".to_owned());
    }
    if text.chars().count() > PROMPT_CHARS {
        return Err(format!(
            "the prompt is too long; keep it under {PROMPT_CHARS} characters."
        ));
    }
    Ok(text.to_owned())
}

fn options(fields: &Map<String, Value>) -> Result<Vec<Choice>, String> {
    let Some(Value::Array(list)) = fields.get("options") else {
        return Err(format!(
            "give `options`, {LEAST_OPTIONS} to {MOST_OPTIONS}, each with a `label`."
        ));
    };
    if list.len() < LEAST_OPTIONS || list.len() > MOST_OPTIONS {
        return Err(format!(
            "give {LEAST_OPTIONS} to {MOST_OPTIONS} options; this has {}.",
            list.len()
        ));
    }
    let mut options: Vec<Choice> = Vec::with_capacity(list.len());
    for raw in list {
        // A bare label is read as an option with that label.
        let (label, detail) = match raw {
            Value::String(label) => (label.as_str(), None),
            Value::Object(option) => {
                if let Some(key) = option.keys().find(|k| *k != "label" && *k != "detail") {
                    return Err(format!("an option has `label` and `detail`, not `{key}`."));
                }
                let label = option.get("label").and_then(Value::as_str).unwrap_or("");
                let detail = match option.get("detail") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(d)) if d.chars().count() <= DETAIL_CHARS => {
                        Some(d.trim().to_owned()).filter(|d| !d.is_empty())
                    }
                    Some(_) => {
                        return Err(format!(
                            "an option's `detail` is text up to {DETAIL_CHARS} characters."
                        ));
                    }
                };
                (label, detail)
            }
            _ => return Err("each option is an object with a `label`.".to_owned()),
        };
        let label = label.trim();
        if label.is_empty() || label.chars().count() > LABEL_CHARS {
            return Err(format!(
                "each option needs a `label` of 1 to {LABEL_CHARS} characters."
            ));
        }
        if options.iter().any(|o| o.label.eq_ignore_ascii_case(label)) {
            return Err(format!("two options are labelled \"{label}\"."));
        }
        options.push(Choice {
            label: label.to_owned(),
            detail,
        });
    }
    Ok(options)
}

fn short(fields: &Map<String, Value>, key: &str) -> Result<Option<String>, String> {
    match fields.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.chars().count() <= SHORT_CHARS => {
            Ok(Some(text.trim().to_owned()).filter(|t| !t.is_empty()))
        }
        Some(_) => Err(format!("`{key}` is text up to {SHORT_CHARS} characters.")),
    }
}

fn flag(fields: &Map<String, Value>, key: &str) -> Result<bool, String> {
    match fields.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(flag)) => Ok(*flag),
        Some(_) => Err(format!("`{key}` must be true or false.")),
    }
}

fn count(fields: &Map<String, Value>, key: &str) -> Result<Option<usize>, String> {
    match fields.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .map(Some)
            .ok_or_else(|| format!("`{key}` must be a whole number, 0 or more.")),
    }
}

fn number(fields: &Map<String, Value>, key: &str) -> Result<Option<f64>, String> {
    match fields.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_f64()
            .filter(|n| n.is_finite())
            .map(Some)
            .ok_or_else(|| format!("`{key}` must be a number.")),
    }
}

/// The person's answers checked against the questions, one per question in order, as they are
/// stored: a `choice` answer is the option's label as the bot wrote it, `choices` are in option
/// order with any `other` text last, a whole number is stored without a fraction. The reason
/// otherwise, naming the question.
pub fn check_answers(questions: &[Question], answers: &[Value]) -> Result<Vec<Value>, String> {
    if answers.len() != questions.len() {
        return Err(format!(
            "Give one answer per question: there are {} questions and {} answers.",
            questions.len(),
            answers.len()
        ));
    }
    questions
        .iter()
        .zip(answers)
        .enumerate()
        .map(|(at, (question, answer))| {
            check_one(&question.kind, answer).map_err(|why| format!("Question {}: {why}", at + 1))
        })
        .collect()
}

fn check_one(kind: &Kind, answer: &Value) -> Result<Value, String> {
    if answer.is_null() {
        return Err("it has no answer.".to_owned());
    }
    match kind {
        Kind::Text { .. } => text(answer).map(Value::String),
        Kind::Connect(_) => Err(super::connect::ANSWERED_BY_CONNECTING.to_owned()),
        Kind::Suggest(_) => Err(super::suggest::ANSWERED_BY_INSTALLING.to_owned()),
        Kind::Choice { options, other } => {
            let picked = answer.as_str().ok_or("the answer is one option's label.")?;
            match label(options, picked) {
                Some(label) => Ok(Value::String(label)),
                None if *other => text(answer).map(Value::String),
                None => Err(format!("\"{}\" is not one of its options.", picked.trim())),
            }
        }
        Kind::Choices {
            options,
            min,
            max,
            other,
        } => {
            let Some(picked) = answer.as_array() else {
                return Err("the answer is a list of the options picked.".to_owned());
            };
            let mut chosen: Vec<usize> = Vec::new();
            let mut own: Option<String> = None;
            for pick in picked {
                let Some(text_picked) = pick.as_str() else {
                    return Err("each pick is an option's label.".to_owned());
                };
                match options.iter().position(|o| matches(&o.label, text_picked)) {
                    Some(at) if chosen.contains(&at) => {
                        return Err(format!("\"{}\" is picked twice.", options[at].label));
                    }
                    Some(at) => chosen.push(at),
                    None if *other && own.is_none() => own = Some(text(pick)?),
                    None if *other => return Err("only one answer of your own.".to_owned()),
                    None => {
                        return Err(format!(
                            "\"{}\" is not one of its options.",
                            text_picked.trim()
                        ));
                    }
                }
            }
            let most = options.len() + usize::from(*other);
            let (least, most) = (min.unwrap_or(1), max.unwrap_or(most));
            let picks = chosen.len() + usize::from(own.is_some());
            if picks < least || picks > most {
                return Err(if least == most {
                    format!("pick {least}; this picks {picks}.")
                } else {
                    format!("pick {least} to {most}; this picks {picks}.")
                });
            }
            chosen.sort_unstable();
            let mut labels: Vec<Value> = chosen
                .into_iter()
                .map(|at| Value::String(options[at].label.clone()))
                .collect();
            labels.extend(own.map(Value::String));
            Ok(Value::Array(labels))
        }
        Kind::Confirm {} => answer
            .as_bool()
            .map(Value::Bool)
            .ok_or_else(|| "the answer is yes (true) or no (false).".to_owned()),
        Kind::Number { min, max, .. } => {
            let n = answer
                .as_f64()
                .filter(|n| n.is_finite())
                .ok_or("the answer is a number.")?;
            if let Some(min) = min
                && n < *min
            {
                return Err(format!("{n} is below the least, {min}."));
            }
            if let Some(max) = max
                && n > *max
            {
                return Err(format!("{n} is above the most, {max}."));
            }
            Ok(whole(n))
        }
        Kind::Date { time } => {
            let given = answer.as_str().map(str::trim).unwrap_or("");
            let fine = if *time { date_time(given) } else { date(given) };
            if fine {
                Ok(Value::String(given.to_owned()))
            } else if *time {
                Err("the answer is a date and time, like 2026-11-15T09:30.".to_owned())
            } else {
                Err("the answer is a date, like 2026-11-15.".to_owned())
            }
        }
    }
}

fn text(answer: &Value) -> Result<String, String> {
    let given = answer.as_str().ok_or("the answer is text.")?.trim();
    if given.is_empty() {
        return Err("it has no answer.".to_owned());
    }
    if given.chars().count() > ANSWER_CHARS {
        return Err(format!(
            "the answer is too long; keep it under {ANSWER_CHARS} characters."
        ));
    }
    Ok(given.to_owned())
}

fn matches(label: &str, given: &str) -> bool {
    label.eq_ignore_ascii_case(given.trim())
}

fn label(options: &[Choice], given: &str) -> Option<String> {
    options
        .iter()
        .find(|o| matches(&o.label, given))
        .map(|o| o.label.clone())
}

fn whole(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        // Exact: whole and within an i64 without loss.
        Value::from(n as i64)
    } else {
        Value::from(n)
    }
}

/// `YYYY-MM-DD`, a real day.
fn date(given: &str) -> bool {
    let parts: Vec<&str> = given.split('-').collect();
    let [y, m, d] = parts.as_slice() else {
        return false;
    };
    if y.len() != 4 || m.len() != 2 || d.len() != 2 {
        return false;
    }
    let (Ok(y), Ok(m), Ok(d)) = (y.parse::<u32>(), m.parse::<u32>(), d.parse::<u32>()) else {
        return false;
    };
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&d)
}

/// `YYYY-MM-DDTHH:MM`, optionally with `:SS` and a `Z` or `±HH:MM` offset.
fn date_time(given: &str) -> bool {
    // Every valid form is ASCII; checked first so the byte slicing below never splits a character.
    if !given.is_ascii() {
        return false;
    }
    let Some((day, clock)) = given.split_once('T') else {
        return false;
    };
    if !date(day) {
        return false;
    }
    let (clock, offset) = match clock.find(['Z', '+', '-']) {
        Some(at) => clock.split_at(at),
        None => (clock, ""),
    };
    let fine_offset = match offset {
        "" | "Z" => true,
        offset => hours_minutes(&offset[1..], 14),
    };
    let fine_clock = match clock.len() {
        5 => hours_minutes(clock, 23),
        8 => {
            hours_minutes(&clock[..5], 23)
                && clock.as_bytes()[5] == b':'
                && clock[6..].parse::<u32>().is_ok_and(|s| s < 60)
        }
        _ => false,
    };
    fine_offset && fine_clock
}

fn hours_minutes(text: &str, most_hours: u32) -> bool {
    let Some((h, m)) = text.split_once(':') else {
        return false;
    };
    h.len() == 2
        && m.len() == 2
        && h.parse::<u32>().is_ok_and(|h| h <= most_hours)
        && m.parse::<u32>().is_ok_and(|m| m < 60)
}

/// The answers a message the person typed gives, when it can stand for them: the text of a
/// single `text` question, or for a single `choice` or `choices` question an option it names or,
/// when the question allows `other`, the person's own text. `None` otherwise: then the message is
/// their reply to the whole card.
pub fn from_message(questions: &[Question], message: &str) -> Option<Vec<Value>> {
    let [question] = questions else {
        return None;
    };
    let given = Value::String(message.trim().to_owned());
    let answer = match &question.kind {
        Kind::Text { .. } => given,
        Kind::Choice { options, other } => {
            if label(options, message).is_none() && !*other {
                return None;
            }
            given
        }
        Kind::Choices { options, other, .. } => {
            if label(options, message).is_none() && !*other {
                return None;
            }
            Value::Array(vec![given])
        }
        _ => return None,
    };
    check_answers(questions, &[answer]).ok()
}
