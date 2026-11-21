//! Questions a bot asks the person (ADR 0154, spade/docs/questions.md): the kinds `ask_user`
//! takes, the checks on its arguments and on the person's answers, how answers read to the bot,
//! and where each question stands, all from the stored events.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::event::{Event, Known};

mod check;
pub mod connect;
pub mod elicit;
mod state;
pub mod suggest;
#[cfg(test)]
mod tests;

pub use check::{check_answers, from_message, parse};
pub use state::{Standing, View, for_later, standing, views};

/// The most questions one `ask_user` call asks.
pub const MOST_QUESTIONS: usize = 5;
/// The longest prompt, in characters.
pub const PROMPT_CHARS: usize = 2_000;
/// The fewest and most options a `choice` or `choices` question offers.
pub const LEAST_OPTIONS: usize = 2;
pub const MOST_OPTIONS: usize = 10;
/// The longest option label and detail, in characters.
pub const LABEL_CHARS: usize = 200;
pub const DETAIL_CHARS: usize = 500;
/// The longest text answer (a `text` answer, or `other` text), in characters.
pub const ANSWER_CHARS: usize = 4_000;

/// What a waiting call reads once the person answered by typing a message: the message follows.
pub const ANSWERED_BY_MESSAGE: &str = crate::context::ANSWERED;

/// What a waiting call reads when the person chose to answer later.
pub const DEFERRED: &str = "The person will answer later. Go on without it where you can, or end \
your reply saying what waits on it. Their answer will arrive as a <question_answer>.";

/// What a call with `wait: false` reads at once.
pub const ASKED_FOR_LATER: &str = "Asked without waiting. The person answers when they like; go \
on with your work. Their answer will arrive as a <question_answer>.";

/// What the bot reads for a dismissed question.
pub const DISMISSED: &str = "The person dismissed this question.";

/// One question of an `ask_user` call, as stored in `question_asked`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Question {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub prompt: String,
    #[serde(flatten)]
    pub kind: Kind,
}

/// A question's kind and the fields that go with it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Kind {
    Text {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        placeholder: Option<String>,
    },
    /// One option, or the person's own text when `other`.
    Choice {
        options: Vec<Choice>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        other: bool,
    },
    /// Any number of options within `min` and `max` (both counted with the `other` text).
    Choices {
        options: Vec<Choice>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min: Option<usize>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<usize>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        other: bool,
    },
    Confirm {},
    Number {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
    },
    /// An ISO 8601 date, or a date-time when `time`.
    Date {
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        time: bool,
    },
    /// Connect an app (`app_connect_request`): made by Spade only, answered by connecting.
    Connect(Box<connect::Connect>),
    /// Install a package a bot suggests (`package_suggest`): made by Spade only from the market's
    /// signed manifest, answered by the person installing it on its review.
    Suggest(Box<suggest::Suggest>),
}

/// An option of a `choice` or `choices` question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Choice {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Kind {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Text { .. } => "text",
            Self::Choice { .. } => "choice",
            Self::Choices { .. } => "choices",
            Self::Confirm {} => "confirm",
            Self::Number { .. } => "number",
            Self::Date { .. } => "date",
            Self::Connect(_) => "connect",
            Self::Suggest(_) => "suggest",
        }
    }
}

/// What a checked `ask_user` call asks.
#[derive(Debug, Clone, PartialEq)]
pub struct Ask {
    pub questions: Vec<Question>,
    /// `false`: stored as deferred from the start, so the turn never pauses.
    pub wait: bool,
}

impl Ask {
    /// The one line `question_asked.question` keeps: the prompts, one per line. Older readers
    /// (history search, the CLI-brain turn) read it.
    pub fn summary(&self) -> String {
        self.questions
            .iter()
            .map(|q| q.prompt.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// The questions a stored `question_asked` asks: its `questions`, or for one stored before
/// kinds existed, its `question` as one `text` question.
pub fn asked(question: &str, questions: &[Question]) -> Vec<Question> {
    if questions.is_empty() {
        vec![Question {
            id: None,
            prompt: question.to_owned(),
            kind: Kind::Text { placeholder: None },
        }]
    } else {
        questions.to_vec()
    }
}

/// The questions `call_id` asked, from the events.
pub fn questions_of(events: &[Event], call_id: &str) -> Option<Vec<Question>> {
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::QuestionAsked {
            call_id: c,
            question,
            questions,
            ..
        }) if c == call_id => Some(asked(question, questions)),
        _ => None,
    })
}

/// Whether a message is the person typing (not another bot, a routine or a group), the only
/// kind that answers a waiting question.
pub fn typed_by_person(event: &Event) -> bool {
    matches!(
        event,
        Event::Known(Known::UserMessage {
            from_agent: None,
            from_routine: None,
            from_group: None,
            ..
        })
    )
}

/// Each prompt with its answer, as the bot reads them.
pub fn shown(questions: &[Question], answers: &[Value]) -> String {
    questions
        .iter()
        .zip(answers)
        .map(|(question, answer)| {
            format!(
                "{}\nAnswer: {}",
                question.prompt,
                answer_text(&question.kind, answer)
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// What a waiting call reads once the person answered in the card.
pub fn answered(questions: &[Question], answers: &[Value]) -> String {
    format!("The person answered.\n\n{}", shown(questions, answers))
}

/// How a late answer, or the dismissal of a deferred question, reads to the bot.
pub fn late(call_id: &str, body: &str) -> String {
    format!("<question_answer call=\"{call_id}\">\n{body}\n</question_answer>")
}

/// A late `question_answered` or `question_dismissed` as the bot reads it, with the questions
/// looked up in `events` (they may sit before a compaction's cut).
pub fn late_text(events: &[Event], event: &Known) -> Option<String> {
    match event {
        Known::QuestionAnswered {
            call_id,
            answers,
            late: true,
            ..
        } => {
            let questions = questions_of(events, call_id).unwrap_or_default();
            let body = match (
                connect::of(&questions),
                suggest::of(&questions),
                answers.first(),
            ) {
                (Some(app), _, Some(answer)) => connect::connected_late(app, answer),
                (_, Some(package), Some(answer)) => suggest::installed_late(package, answer),
                _ => shown(&questions, answers),
            };
            Some(late(call_id, &body))
        }
        Known::QuestionDismissed {
            call_id,
            late: true,
        } => {
            let questions = questions_of(events, call_id).unwrap_or_default();
            let body = match (connect::of(&questions), suggest::of(&questions)) {
                (Some(app), _) => connect::dismissed(app),
                (_, Some(package)) => suggest::dismissed(package),
                _ => DISMISSED.to_owned(),
            };
            Some(late(call_id, &body))
        }
        _ => None,
    }
}

/// Whether the event is a late answer or dismissal: it reaches the model like a job's result.
pub fn is_late(event: &Known) -> bool {
    matches!(
        event,
        Known::QuestionAnswered { late: true, .. } | Known::QuestionDismissed { late: true, .. }
    )
}

fn answer_text(kind: &Kind, answer: &Value) -> String {
    match (kind, answer) {
        (Kind::Connect(app), _) => connect::connected_late(app, answer),
        (Kind::Suggest(package), _) => suggest::installed_late(package, answer),
        (Kind::Confirm {}, Value::Bool(yes)) => if *yes { "yes" } else { "no" }.to_owned(),
        (Kind::Number { unit, .. }, Value::Number(n)) => match unit {
            Some(unit) => format!("{n} {unit}"),
            None => n.to_string(),
        },
        (Kind::Choice { options, .. }, Value::String(text)) => {
            if options.iter().any(|o| &o.label == text) {
                text.clone()
            } else {
                format!("{text} (in their own words)")
            }
        }
        (Kind::Choices { options, .. }, Value::Array(picked)) => {
            let names: Vec<String> = picked
                .iter()
                .filter_map(Value::as_str)
                .map(|text| {
                    if options.iter().any(|o| o.label == text) {
                        text.to_owned()
                    } else {
                        format!("{text} (in their own words)")
                    }
                })
                .collect();
            if names.is_empty() {
                "none".to_owned()
            } else {
                names.join(", ")
            }
        }
        (_, Value::String(text)) => text.clone(),
        (_, other) => other.to_string(),
    }
}

fn object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

/// What `call_id`'s waiting call reads once it no longer waits: the answers given in the card,
/// "their reply follows" when a typed message answered it, or that it was left for later or
/// dismissed. `None` while it still waits (or it asked nothing).
pub fn call_result(events: &[Event], call_id: &str) -> Option<String> {
    let at = events.iter().rposition(|event| {
        matches!(event, Event::Known(Known::QuestionAsked { call_id: c, .. }) if c == call_id)
    })?;
    let questions = questions_of(events, call_id).unwrap_or_default();
    let app = connect::of(&questions);
    let package = suggest::of(&questions);
    events[at..].iter().find_map(|event| {
        if typed_by_person(event) {
            return Some(ANSWERED_BY_MESSAGE.to_owned());
        }
        match event {
            Event::Known(Known::QuestionDeferred { call_id: c, by_bot }) if c == call_id => {
                Some(match (app, package) {
                    (Some(app), _) => connect::deferred(app),
                    (_, Some(package)) => suggest::deferred(package),
                    _ if *by_bot => ASKED_FOR_LATER.to_owned(),
                    _ => DEFERRED.to_owned(),
                })
            }
            Event::Known(Known::QuestionAnswered {
                call_id: c,
                answers,
                late: false,
                typed: false,
            }) if c == call_id => Some(match (app, package, answers.first()) {
                (Some(app), _, Some(answer)) => connect::connected(app, answer),
                (_, Some(package), Some(answer)) => suggest::installed(package, answer),
                _ => answered(&questions, answers),
            }),
            Event::Known(Known::QuestionDismissed {
                call_id: c,
                late: false,
            }) if c == call_id => Some(match (app, package) {
                (Some(app), _) => connect::dismissed(app),
                (_, Some(package)) => suggest::dismissed(package),
                _ => DISMISSED.to_owned(),
            }),
            _ => None,
        }
    })
}

/// The `question_answered` a message the person typed stands for, when exactly one question
/// card waits and the message can stand for its answers ([`from_message`]). Stored right after
/// the message; `None` otherwise, and the message is the person's reply to the card.
pub fn typed_answer(events: &[Event], message: &Event) -> Option<Event> {
    if !typed_by_person(message) {
        return None;
    }
    let Event::Known(Known::UserMessage { text, .. }) = message else {
        return None;
    };
    // An app's form is the person's to answer on its card, never by a message.
    let waiting: Vec<View> = views(events)
        .into_iter()
        .filter(|c| c.standing == Standing::Waiting && elicit::call_of(&c.call_id).is_none())
        .collect();
    let [card] = waiting.as_slice() else {
        return None;
    };
    let answers = from_message(&card.questions, text)?;
    Some(Event::Known(Known::QuestionAnswered {
        call_id: card.call_id.clone(),
        answers,
        late: false,
        typed: true,
    }))
}
