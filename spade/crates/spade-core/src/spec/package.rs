//! The `package` part's regions, from `spade_core::package::manifest`'s own lists and bounds.

use super::conformance;
use super::markdown::{cases, code_list, number, table};
use crate::effect::runtime::Module;
use crate::package::manifest as m;
use crate::routine;

/// What each field of a version 3 `bot.json` is. Every field the reader knows has a line here,
/// and only those: the writer refuses otherwise, so a field can't be added to the reader and
/// left out of the spec.
const FIELDS: [(&str, &str); 23] = [
    ("format", "MUST be `\"spade-bot\"`."),
    (
        "version",
        "The format's number, `3`. A string is refused: a package's own version is the signed version manifest's.",
    ),
    (
        "requires",
        "`{runtime, spade?}`: the major version of the `runtime` part it needs, as a string, and the oldest runtime build whose additions it uses.",
    ),
    ("name", "The bot's name, required."),
    ("blurb", "One line on what it does."),
    (
        "task",
        "What the bot is for, in words, as its standing instruction.",
    ),
    ("face", "How the bot looks: a character, never a picture."),
    ("style", "`{accent}`: one colour, like `#2F7BEA`."),
    ("personality", "`{tone, humour, emoji}`."),
    (
        "model",
        "`fast` or `capable` (the default): a kind of model, never a model of its own.",
    ),
    (
        "uses",
        "The `runtime` modules the bot uses; its tools are narrowed to them. Missing means every module.",
    ),
    (
        "triggers",
        "What starts the bot's work (below). Missing means `message`.",
    ),
    ("skills", "Skills by reference."),
    (
        "plugins",
        "Plugins by reference, which the person accepts on their own.",
    ),
    (
        "needs",
        "`{tools?, connectors?}`: built-in tools and connected apps it needs.",
    ),
    (
        "effects",
        "What it may do beyond reading and its own things: the ceiling ([effects](effects.md)).",
    ),
    (
        "limits",
        "`spend_alert {usd_per_day}`, `workers_at_once`, `workspace_mb`: an alert line and bounds, never a stop.",
    ),
    (
        "tests",
        "Scenario files in the package ([distribution](distribution.md)).",
    ),
    ("notes", "Starting notes the bot keeps."),
    (
        "pricing",
        "`{kind: \"free\"}`; missing reads as free, and any other price is refused.",
    ),
    ("surfaces", "Cards and panels ([surfaces](surfaces.md))."),
    (
        "contracts",
        "Typed calls other bots of the person may make to it ([contracts](contracts.md)).",
    ),
    (
        "checks",
        "What a result is held to before it counts as done: `schema` rules on contract outputs and cards, `criterion` lines on the goal (below).",
    ),
];

pub fn regions() -> Result<Vec<(&'static str, String)>, Vec<String>> {
    Ok(vec![
        ("fields", fields()?),
        ("v2", format!("{}.\n", code_list(m::KNOWN_V2))),
        ("refused", refused()),
        ("bounds", bounds()),
        ("modules", modules()),
        ("triggers", triggers()),
        ("cases", cases(&conformance::MANIFESTS[0])),
        ("checks", checks()),
        ("check-cases", cases(&conformance::MANIFESTS[4])),
        ("rule-cases", cases(&conformance::RULES)),
    ])
}

fn fields() -> Result<String, Vec<String>> {
    let mut problems = Vec::new();
    for known in m::KNOWN_V3 {
        if !FIELDS.iter().any(|(field, _)| *field == known) {
            problems.push(format!("bot.json's {known:?} has no line in the spec"));
        }
    }
    for (field, _) in FIELDS {
        if !m::KNOWN_V3.contains(&field) {
            problems.push(format!(
                "the spec describes {field:?}, which the reader doesn't know"
            ));
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    let rows = m::KNOWN_V3.iter().map(|known| {
        let about = FIELDS
            .iter()
            .find(|(field, _)| field == known)
            .map_or("", |(_, about)| about);
        vec![format!("`{known}`"), about.to_owned()]
    });
    Ok(table(&["Field", "What it is"], rows))
}

fn refused() -> String {
    format!(
        "- **Identity**, which is the signed version manifest's alone: {}.\n\
         - **Executions**, which are plugins', never a package's: {}.\n",
        code_list(m::IDENTITY),
        code_list(m::EXECUTIONS)
    )
}

fn bounds() -> String {
    let rows: [(&str, String); 16] = [
        ("`name`", format!("at most {} characters", m::NAME_CHARS)),
        ("`blurb`", format!("at most {} characters", m::BLURB_CHARS)),
        ("`triggers`", format!("at most {}", m::MOST_TRIGGERS)),
        (
            "routines (schedule, event and webhook triggers)",
            format!("at most {}, each name once", m::MOST_ROUTINES),
        ),
        (
            "a routine's `name`",
            format!("1 to {} characters", routine::NAME_CHARS),
        ),
        (
            "a routine's `instruction`",
            format!(
                "1 to {} characters",
                number(routine::INSTRUCTION_CHARS as u64)
            ),
        ),
        ("`effects`", format!("at most {}", m::MOST_EFFECTS)),
        (
            "an effect's `why`",
            format!("1 to {} characters", m::WHY_CHARS),
        ),
        ("an effect's `hosts`", format!("1 to {}", m::MOST_HOSTS)),
        ("`needs.tools`", format!("at most {}", m::MOST_TOOLS)),
        (
            "`skills`, `plugins`",
            format!("at most {} each", m::MOST_REFS),
        ),
        ("`tests`", format!("at most {}", m::MOST_TESTS)),
        (
            "`notes`",
            format!(
                "at most {}, each at most {} characters",
                m::MOST_NOTES,
                number(m::NOTE_CHARS as u64)
            ),
        ),
        (
            "`limits.spend_alert.usd_per_day`",
            format!("0 to {}", number(m::MOST_SPEND_ALERT_USD as u64)),
        ),
        (
            "`limits.workers_at_once`",
            format!("1 to {}", m::MOST_WORKERS_AT_ONCE),
        ),
        (
            "`limits.workspace_mb`",
            format!("1 to {}", number(m::MOST_WORKSPACE_MB)),
        ),
    ];
    table(
        &["What", "Bound"],
        rows.into_iter()
            .map(|(what, bound)| vec![what.to_owned(), bound]),
    )
}

fn modules() -> String {
    table(
        &["Module", "What it holds"],
        Module::ALL
            .into_iter()
            .map(|module| vec![format!("`{}`", module.name()), module.about().to_owned()]),
    )
}

/// A check's fields, kinds and bounds, and the rule subset's keywords.
fn checks() -> String {
    use crate::package::checks as c;
    use crate::quality::rule as r;
    let rows = [
        ("checks in a package", format!("at most {}", c::MOST_CHECKS)),
        (
            "a check's `name`",
            format!(
                "1 to {} lower-case letters, digits and dashes, each once",
                c::NAME_CHARS
            ),
        ),
        ("a check's `on`", format!("1 to {} places", c::MOST_ON)),
        (
            "`criterion` checks",
            format!(
                "at most {}, each `text` at most {} characters",
                c::MOST_CRITERIA,
                c::TEXT_CHARS
            ),
        ),
        (
            "a rule's `pattern`",
            format!(
                "1 to {} characters, counts at most {}",
                r::PATTERN_CHARS,
                number(u64::from(r::MOST_REPEAT))
            ),
        ),
    ];
    let keywords = [
        ("object", &r::OBJECT_KEYWORDS[..]),
        ("string", &r::STRING_KEYWORDS[..]),
        ("number, integer", &r::NUMBER_KEYWORDS[..]),
        ("array", &r::ARRAY_KEYWORDS[..]),
    ];
    format!(
        "A check has {}.\n\n{}\nA rule's keywords, by the kind of value they narrow (every rule also takes {}):\n\n{}",
        code_list(c::FIELDS),
        table(
            &["What", "Bound"],
            rows.into_iter()
                .map(|(what, bound)| vec![what.to_owned(), bound]),
        ),
        code_list(r::COMMON),
        table(
            &["Kind", "Keywords"],
            keywords
                .into_iter()
                .map(|(kind, words)| vec![format!("`{kind}`"), code_list(words.iter().copied())]),
        )
    )
}

fn triggers() -> String {
    format!(
        "An `event` trigger names one of: {}.\n",
        m::ACE_EVENTS
            .iter()
            .map(|(word, event)| format!("`{word}` ({})", event.words().to_lowercase()))
            .collect::<Vec<_>>()
            .join(", ")
    )
}
