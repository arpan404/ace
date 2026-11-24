//! Learned tool pinning (spade/docs/harness.md, Tools): a deferred tool a bot keeps reaching for
//! is offered up front from its next conversation or compaction, so it costs no `tool_search`
//! round trip. Pure: what a bot used, in, and the pins, out; the engine stores both.

use std::collections::BTreeMap;

/// The most deferred tools a bot is offered up front, so the fixed prompt stays small.
pub const LIMIT: usize = 8;

/// How many times a bot must run a deferred tool before it is pinned: once may be chance.
pub const REPEATS: u32 = 2;

/// The most tools a tally remembers, so the stored setting stays small.
pub const REMEMBERED: usize = 32;

/// The setting a bot's tally of deferred tool runs is stored under, by its agent id.
pub fn uses_key(agent: &str) -> String {
    format!("tools.uses.{agent}")
}

/// How often a bot ran each deferred tool.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Uses(BTreeMap<String, u32>);

impl Uses {
    /// Reads a stored tally: one `name<TAB>count` per line. Lines that don't fit are left out,
    /// so an old or damaged setting pins nothing rather than failing a turn.
    pub fn parse(text: &str) -> Self {
        let mut uses = Self::default();
        for line in text.lines() {
            let Some((name, count)) = line.rsplit_once('\t') else {
                continue;
            };
            let (Ok(count), false) = (count.parse::<u32>(), name.trim().is_empty()) else {
                continue;
            };
            if count > 0 {
                uses.0.insert(name.trim().to_owned(), count);
            }
        }
        uses
    }

    /// The tally as stored: names in order, so the same uses are always the same bytes.
    pub fn text(&self) -> String {
        self.0
            .iter()
            .map(|(name, count)| format!("{name}\t{count}\n"))
            .collect()
    }

    /// Notes one run of `name`.
    pub fn record(&mut self, name: &str) {
        *self.0.entry(name.to_owned()).or_insert(0) += 1;
        if self.0.len() > REMEMBERED {
            self.0 = self.ranked().into_iter().take(REMEMBERED).collect();
        }
    }

    /// The tools run `REPEATS` times or more, most run first (ties by name), at most [`LIMIT`].
    pub fn pinned(&self) -> Vec<String> {
        self.ranked()
            .into_iter()
            .filter(|(_, count)| *count >= REPEATS)
            .take(LIMIT)
            .map(|(name, _)| name)
            .collect()
    }

    fn ranked(&self) -> Vec<(String, u32)> {
        let mut ranked: Vec<(String, u32)> = self
            .0
            .iter()
            .map(|(name, count)| (name.clone(), *count))
            .collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        ranked
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uses(names: &[&str]) -> Uses {
        let mut uses = Uses::default();
        for name in names {
            uses.record(name);
        }
        uses
    }

    #[test]
    fn a_tool_a_bot_ran_twice_is_pinned_and_one_it_ran_once_is_not() {
        assert!(uses(&["card_show"]).pinned().is_empty());
        assert_eq!(uses(&["card_show", "card_show"]).pinned(), ["card_show"]);
    }

    #[test]
    fn pins_are_the_most_run_first_ties_by_name_and_at_most_eight() {
        let mut uses = uses(&["b", "b", "a", "a", "c", "c", "c"]);
        for name in ["d", "e", "f", "g", "h", "i", "j"] {
            uses.record(name);
            uses.record(name);
        }
        assert_eq!(
            uses.pinned(),
            ["c", "a", "b", "d", "e", "f", "g", "h"],
            "three runs first, then ties by name, eight at most"
        );
    }

    #[test]
    fn a_stored_tally_reads_back_the_same_and_ignores_lines_that_do_not_fit() {
        let uses = uses(&["card_show", "card_show", "notify"]);
        let text = uses.text();
        assert_eq!(text, "card_show\t2\nnotify\t1\n");
        assert_eq!(Uses::parse(&text), uses);
        assert_eq!(
            Uses::parse("garbage\n\nx\tnope\n\t3\nok\t2\n").pinned(),
            ["ok"]
        );
    }

    #[test]
    fn a_tally_remembers_only_what_is_run_most() {
        let mut uses = Uses::default();
        for n in 0..REMEMBERED {
            uses.record(&format!("tool_{n:02}"));
        }
        uses.record("late");
        uses.record("late");
        assert_eq!(
            uses.pinned(),
            ["late"],
            "a tool run now outranks one run once"
        );
        assert!(Uses::parse(&uses.text()).0.len() <= REMEMBERED);
    }
}
