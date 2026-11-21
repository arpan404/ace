//! The `surfaces` part's regions: the bounds `spade_core::package::surfaces`, `spade_core::panel`
//! and `spade_core::card` check, and the card parts `card_show` offers.

use super::conformance;
use super::markdown::{bytes, cases, code_list, level_cases, rules, table};
use crate::card;
use crate::package::surfaces as declared;
use crate::panel;

pub fn regions() -> Vec<(&'static str, String)> {
    vec![
        ("bounds", bounds()),
        ("blocks", blocks()),
        ("card-bounds", card_bounds()),
        (
            "level-cases",
            level_cases(&[&conformance::LEVELS[2], &conformance::LEVELS[3]]),
        ),
        ("rules", rules("surfaces")),
        ("cases", cases(&conformance::MANIFESTS[3])),
    ]
}

fn rows(rows: Vec<(&str, String)>) -> Vec<Vec<String>> {
    rows.into_iter()
        .map(|(what, bound)| vec![what.to_owned(), bound])
        .collect()
}

fn bounds() -> String {
    table(
        &["What", "Bound"],
        rows(vec![
            ("`surfaces`", format!("at most {}", declared::MOST_SURFACES)),
            (
                "panels among them",
                format!("at most {}", declared::MOST_PANELS),
            ),
            (
                "a panel's `title`",
                format!("at most {} characters", declared::TITLE_CHARS),
            ),
            (
                "a panel's `actions`",
                format!("at most {}", declared::MOST_ACTIONS),
            ),
            (
                "an action's `label`",
                format!("at most {} characters", declared::LABEL_CHARS),
            ),
            ("a panel's state, as JSON", bytes(panel::MOST_STATE_BYTES)),
            ("an action's value, as JSON", bytes(panel::MOST_VALUE_BYTES)),
            ("a panel's page", bytes(panel::MOST_PAGE_BYTES)),
        ]),
    )
}

/// The block kinds, as `card_show`'s own input schema lists them to the model.
fn blocks() -> String {
    let schema = card::schema();
    let kinds = schema["properties"]["data"]["properties"]["blocks"]["items"]["properties"]["kind"]
        ["enum"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let kinds: Vec<&str> = kinds.iter().filter_map(|kind| kind.as_str()).collect();
    format!(
        "A card's blocks are of these kinds: {}.\n",
        code_list(kinds)
    )
}

fn card_bounds() -> String {
    table(
        &["What", "Bound"],
        rows(vec![
            (
                "blocks under the title",
                format!("at most {}", card::MOST_BLOCKS),
            ),
            (
                "the title",
                format!("at most {} characters", card::TITLE_CHARS),
            ),
            (
                "a label",
                format!("at most {} characters", card::LABEL_CHARS),
            ),
            (
                "an action's label",
                format!("at most {} characters", card::ACTION_CHARS),
            ),
            (
                "a value or a list item",
                format!("at most {} characters", card::VALUE_CHARS),
            ),
            (
                "a table cell",
                format!("at most {} characters", card::CELL_CHARS),
            ),
            ("`fields` rows", format!("at most {}", card::MOST_FIELDS)),
            ("`list` items", format!("at most {}", card::MOST_ITEMS)),
            ("`table` columns", format!("at most {}", card::MOST_COLUMNS)),
            ("`table` rows", format!("at most {}", card::MOST_ROWS)),
            (
                "actions on a card",
                format!("at most {}", card::MOST_ACTIONS),
            ),
            ("the whole card, as JSON", bytes(card::MOST_BYTES)),
        ]),
    )
}
