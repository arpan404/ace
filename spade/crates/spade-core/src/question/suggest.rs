//! A card where a bot suggests a package (`package_suggest`, ADR 0200 §8, §10 phase 2): a kind of
//! question only Spade makes, from the market's signed manifest and the `bot.json` it covers,
//! never from what the bot wrote beyond its reason. The person answers it by installing the
//! package through the normal install review; Spade stores that as the card's answer, so waiting,
//! Later, Not now, restarts and late answers are the question card's own (ADR 0154). The bot
//! never installs anything.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{Kind, Question};
use crate::effect::Effect;
use crate::package::Manifest;

/// The tool a bot calls to suggest a package to the person.
pub const PACKAGE_SUGGEST: &str = "package_suggest";
/// The longest reason a bot gives, in characters.
pub const WHY_CHARS: usize = 300;
/// The longest one line on what the package does, in characters.
pub const BLURB_CHARS: usize = 200;
/// The most lines of what it would be allowed to do.
const MOST_CAN: usize = 8;

/// Who published the package, from the market's signed manifest only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Publisher {
    pub id: String,
    pub name: String,
}

/// The package a suggest card is about.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Suggest {
    /// Where it is listed (`market`) and its entry name there.
    pub source: String,
    pub package: String,
    /// The version the market lists and signed.
    pub version: String,
    /// The bot's name, face and one line from its `bot.json`.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub face: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub blurb: String,
    pub publisher: Publisher,
    /// What it would be allowed to do, a few words each: its declared effects and apps. Each is
    /// a switch on the install review, nothing granted before Install.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub can: Vec<String>,
}

/// What installing stores as the card's answer: the bot the install made.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Installed {
    pub bot: String,
    pub name: String,
}

impl Installed {
    pub fn answer(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    pub fn read(answer: &Value) -> Option<Self> {
        serde_json::from_value(answer.clone()).ok()
    }
}

/// The card for `manifest`, listed as `package` at `version` in `source` by `publisher`.
pub fn card(
    source: &str,
    package: &str,
    version: &str,
    publisher: Publisher,
    manifest: &Manifest,
) -> Suggest {
    Suggest {
        source: source.to_owned(),
        package: package.to_owned(),
        version: version.to_owned(),
        name: manifest.name.clone(),
        face: manifest.face.clone(),
        blurb: one_line(&manifest.blurb, BLURB_CHARS),
        publisher,
        can: can(manifest),
    }
}

/// What a package would be allowed to do, in a few words each, from what it declares.
pub fn can(manifest: &Manifest) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for declared in &manifest.effects {
        let line = match declared.effect {
            Effect::Network if !declared.hosts.is_empty() => {
                format!("Reach {}", declared.hosts.join(", "))
            }
            Effect::Network => "Reach the internet".to_owned(),
            Effect::Publish => "Publish things".to_owned(),
            Effect::SendAsPerson => "Send messages as you".to_owned(),
            Effect::Pay => "Spend money".to_owned(),
            Effect::ChangeAccess => "Change who has access".to_owned(),
            Effect::Drive => "Act in pages and apps as you".to_owned(),
            Effect::Unknown => "Something this Spade can't read yet".to_owned(),
            Effect::Read | Effect::WriteLocal | Effect::Credential => continue,
        };
        if !lines.contains(&line) {
            lines.push(line);
        }
    }
    for app in &manifest.connectors {
        lines.push(format!("Ask to use {app}"));
    }
    if manifest.routines().next().is_some() {
        lines.push("Run on a schedule".to_owned());
    }
    lines.truncate(MOST_CAN);
    lines
}

/// `text` as one line of at most `most` characters.
fn one_line(text: &str, most: usize) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= most {
        return line;
    }
    let cut: String = line.chars().take(most.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// The card's one question.
pub fn question(why: String, suggest: Suggest) -> Question {
    Question {
        id: None,
        prompt: why,
        kind: Kind::Suggest(Box::new(suggest)),
    }
}

/// The package a card's questions suggest, when it is a suggest card.
pub fn of(questions: &[Question]) -> Option<&Suggest> {
    match questions {
        [
            Question {
                kind: Kind::Suggest(suggest),
                ..
            },
        ] => Some(suggest),
        _ => None,
    }
}

/// The card's one-line summary, as `question_asked.question` keeps it.
pub fn summary(suggest: &Suggest, why: &str) -> String {
    format!("Install {}: {why}", suggest.name)
}

fn bot_name(answer: &Value) -> String {
    Installed::read(answer).map_or_else(String::new, |i| i.name)
}

/// What the waiting call reads once the person installed it.
pub fn installed(suggest: &Suggest, answer: &Value) -> String {
    format!(
        "The person installed {} as a new bot, {}. It is its own bot: reach it with bot_message \
         if you need it, and carry on.",
        suggest.name,
        bot_name(answer)
    )
}

/// What a late answer reads, inside its `<question_answer>`.
pub fn installed_late(suggest: &Suggest, answer: &Value) -> String {
    format!(
        "The person installed {} as a new bot, {}. Reach it with bot_message if you need it.",
        suggest.name,
        bot_name(answer)
    )
}

/// What the waiting call reads when the person chose Later.
pub fn deferred(suggest: &Suggest) -> String {
    format!(
        "The person will look at {} later. Go on without it. If they install it you'll get a \
         <question_answer>.",
        suggest.name
    )
}

/// What the bot reads when the person said Not now.
pub fn dismissed(suggest: &Suggest) -> String {
    format!(
        "The person chose not to install {} now. Carry on without it, and don't suggest it again \
         for this task.",
        suggest.name
    )
}

/// What a suggest card answered in the card checks: never an answer the person posts, since
/// only installing answers it.
pub const ANSWERED_BY_INSTALLING: &str =
    "this suggests a package: review and install it, or choose Later or Not now.";

/// `{package, why}` and nothing else: a bot only suggests; it never installs, picks switches or
/// names a version.
pub fn parse(arguments: &Value) -> Result<(String, String), String> {
    let Some(fields) = arguments.as_object() else {
        return Err("Give `package` and `why`.".to_owned());
    };
    if let Some(other) = fields
        .keys()
        .find(|k| !["package", "why"].contains(&k.as_str()))
    {
        return Err(format!(
            "Refused: `{other}` isn't taken. Only the person installs a package, on its install \
             review; you can only suggest one, with `package` and `why`."
        ));
    }
    let package = fields
        .get("package")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or("Give `package`: its name in the market, such as flight-watcher.")?;
    let why = fields
        .get("why")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .ok_or("Give `why`: one line the person reads, saying why it would help them.")?;
    if why.chars().count() > WHY_CHARS {
        return Err(format!(
            "Keep `why` to one line, under {WHY_CHARS} characters."
        ));
    }
    let named = package.chars().all(|c| {
        c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.')
    }) && package.len() <= 64;
    if !named {
        return Err(format!(
            "There's no package called {package} in the market: a package's name is lowercase \
             letters, digits and dashes."
        ));
    }
    Ok((package.to_owned(), one_line(why, WHY_CHARS)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_bot_can_only_name_a_package_and_a_reason() {
        assert_eq!(
            parse(&json!({ "package": "flight-watcher", "why": "You asked about fares" })),
            Ok(("flight-watcher".to_owned(), "You asked about fares".to_owned()))
        );
        for refused in [
            json!({ "package": "flight-watcher", "why": "x", "switches": {} }),
            json!({ "package": "flight-watcher", "why": "x", "version": "1.0.0" }),
            json!({ "package": "", "why": "x" }),
            json!({ "package": "flight-watcher" }),
            json!({ "package": "../etc", "why": "x" }),
            json!({ "package": "Flight Watcher", "why": "x" }),
            json!("flight-watcher"),
        ] {
            assert!(parse(&refused).is_err(), "{refused}");
        }
        let long = "a".repeat(WHY_CHARS + 1);
        assert!(parse(&json!({ "package": "p", "why": long })).is_err());
    }

    #[test]
    fn a_card_reads_back_from_its_question() {
        let suggest = Suggest {
            source: "market".into(),
            package: "flight-watcher".into(),
            version: "1.0.0".into(),
            name: "Flight watcher".into(),
            face: None,
            blurb: "Watches fares.".into(),
            publisher: Publisher {
                id: "p".into(),
                name: "fares-inc".into(),
            },
            can: vec!["Reach api.fares.example".into()],
        };
        let asked = vec![question("You fly often".into(), suggest.clone())];
        let stored = serde_json::to_value(&asked).unwrap_or_default();
        assert_eq!(stored[0]["kind"], "suggest");
        let back: Vec<Question> = serde_json::from_value(stored).unwrap_or_default();
        assert_eq!(of(&back), Some(&suggest));
        let answer = Installed {
            bot: "agt_1".into(),
            name: "Flight watcher".into(),
        }
        .answer();
        assert!(installed(&suggest, &answer).contains("installed Flight watcher"));
    }
}
