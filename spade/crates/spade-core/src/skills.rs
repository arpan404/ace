//! The skill index a conversation starts with, and skill search (ADR 0130, ADR 0151 point 6).
//! Pure: the engine reads the skills and this bot's use of them and passes both in.

use std::collections::{HashMap, HashSet};

/// A skill as Spade offers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Only the person starts it; never listed for the model to load on its own.
    pub manual: bool,
    /// SKILL.md below its frontmatter, for search; empty when not known.
    pub body: String,
}

/// How one bot has used a skill.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Use {
    /// Times the bot loaded it.
    pub loads: u32,
    /// The bot's latest verdict on it was helpful.
    pub helpful: bool,
}

/// The most skills the index lists; the rest are found with `skill_search`.
pub const INDEX_SKILLS: usize = 40;
/// The longest description the index keeps, in characters.
const INDEX_DESCRIPTION: usize = 160;

/// A match in the name counts this much, in the description this much, in the body this much.
const NAME_WEIGHT: f64 = 4.0;
const DESCRIPTION_WEIGHT: f64 = 2.0;
const BODY_WEIGHT: f64 = 1.0;

/// The index frozen into the conversation's instructions at its first step: the skills this bot
/// loaded most, then by name, with a short description. The same skills and use give the same
/// bytes.
pub fn index(skills: &[SkillEntry], uses: &HashMap<String, Use>) -> String {
    let mut offered: Vec<&SkillEntry> = skills.iter().filter(|s| !s.manual).collect();
    if offered.is_empty() {
        return String::new();
    }
    let loads = |s: &SkillEntry| uses.get(&s.name).map_or(0, |u| u.loads);
    offered.sort_by(|a, b| loads(b).cmp(&loads(a)).then_with(|| a.name.cmp(&b.name)));
    let mut out = String::from(
        "Skills: instructions for particular tasks. When one fits, load it with skill_load before \
         starting; find others with skill_search.\n",
    );
    for skill in offered.iter().take(INDEX_SKILLS) {
        out.push_str(&format!(
            "- {}: {}\n",
            skill.name,
            short(&skill.description)
        ));
    }
    if offered.len() > INDEX_SKILLS {
        out.push_str(&format!(
            "- and {} more; find them with skill_search.\n",
            offered.len() - INDEX_SKILLS
        ));
    }
    out
}

/// Skills matching `query`, best first, at most `limit`. Each word of the query (two letters or
/// more) that begins a word of a skill's name, description or body counts, the name most and
/// the body least, and a word few skills have counts more than a common one. Equal scores go to
/// the skill this bot marked helpful, then the one it loaded more, then by name. Manual skills
/// are left out.
pub fn search<'a>(
    skills: &'a [SkillEntry],
    query: &str,
    limit: usize,
    uses: &HashMap<String, Use>,
) -> Vec<&'a SkillEntry> {
    let mut words: Vec<String> = words_of(query).collect();
    words.sort();
    words.dedup();
    let offered: Vec<(&SkillEntry, Fields)> = skills
        .iter()
        .filter(|s| !s.manual)
        .map(|s| (s, Fields::of(s)))
        .collect();
    let total = offered.len() as f64;
    let rarity: Vec<f64> = words
        .iter()
        .map(|w| {
            let having = offered.iter().filter(|(_, f)| f.any(w)).count() as f64;
            (1.0 + total / (1.0 + having)).ln()
        })
        .collect();
    let mut scored: Vec<(u64, &SkillEntry)> = offered
        .iter()
        .filter_map(|(skill, fields)| {
            let score: f64 = words
                .iter()
                .zip(&rarity)
                .map(|(w, weight)| {
                    let place = if fields.name.has(w) {
                        NAME_WEIGHT
                    } else if fields.description.has(w) {
                        DESCRIPTION_WEIGHT
                    } else if fields.body.has(w) {
                        BODY_WEIGHT
                    } else {
                        0.0
                    };
                    place * weight
                })
                .sum();
            // Whole thousandths, so equal matches are equal and ties fall to use.
            let score = (score * 1000.0).round() as u64;
            (score > 0).then_some((score, *skill))
        })
        .collect();
    let used = |s: &SkillEntry| uses.get(&s.name).copied().unwrap_or_default();
    scored.sort_by(|(sa, a), (sb, b)| {
        sb.cmp(sa)
            .then_with(|| used(b).helpful.cmp(&used(a).helpful))
            .then_with(|| used(b).loads.cmp(&used(a).loads))
            .then_with(|| a.name.cmp(&b.name))
    });
    scored.into_iter().take(limit).map(|(_, s)| s).collect()
}

/// The skill named `name` (exactly, then ignoring case), if the model may load it.
pub fn find<'a>(skills: &'a [SkillEntry], name: &str) -> Option<&'a SkillEntry> {
    let name = name.trim();
    skills
        .iter()
        .filter(|s| !s.manual)
        .find(|s| s.name == name)
        .or_else(|| {
            skills
                .iter()
                .filter(|s| !s.manual)
                .find(|s| s.name.eq_ignore_ascii_case(name))
        })
}

/// Lowercase words of two letters or more.
fn words_of(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 2)
        .map(str::to_lowercase)
}

/// The words of one field.
struct Words(HashSet<String>);

impl Words {
    fn of(text: &str) -> Self {
        Self(words_of(text).collect())
    }

    /// Some word of the field begins with `word`: `review` finds `reviews` and `reviewing`.
    fn has(&self, word: &str) -> bool {
        self.0.contains(word) || self.0.iter().any(|w| w.starts_with(word))
    }
}

struct Fields {
    name: Words,
    description: Words,
    body: Words,
}

impl Fields {
    fn of(skill: &SkillEntry) -> Self {
        Self {
            name: Words::of(&skill.name),
            description: Words::of(&skill.description),
            body: Words::of(&skill.body),
        }
    }

    fn any(&self, word: &str) -> bool {
        self.name.has(word) || self.description.has(word) || self.body.has(word)
    }
}

fn short(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= INDEX_DESCRIPTION {
        return line;
    }
    let kept: String = line.chars().take(INDEX_DESCRIPTION - 1).collect();
    format!("{}…", kept.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(name: &str, description: &str, manual: bool) -> SkillEntry {
        with_body(name, description, "", manual)
    }

    fn with_body(name: &str, description: &str, body: &str, manual: bool) -> SkillEntry {
        SkillEntry {
            id: format!("skl_{name}"),
            name: name.into(),
            description: description.into(),
            manual,
            body: body.into(),
        }
    }

    fn none() -> HashMap<String, Use> {
        HashMap::new()
    }

    fn names<'a>(found: &[&'a SkillEntry]) -> Vec<&'a str> {
        found.iter().map(|s| s.name.as_str()).collect()
    }

    #[test]
    fn the_index_lists_skills_by_name_and_leaves_out_manual_ones() {
        let skills = [
            skill("review-code", "Review a branch or PR", false),
            skill("deploy", "Ship to production", true),
            skill("open-pr", "Open a pull request", false),
        ];
        let text = index(&skills, &none());
        assert!(
            text.ends_with(
                "- open-pr: Open a pull request\n- review-code: Review a branch or PR\n"
            ),
            "{text}"
        );
        assert!(!text.contains("deploy"));
        assert_eq!(index(&[], &none()), "");
    }

    #[test]
    fn a_big_library_is_capped_and_points_to_search() {
        let skills: Vec<SkillEntry> = (0..INDEX_SKILLS + 5)
            .map(|i| skill(&format!("skill-{i:03}"), &"long words ".repeat(40), false))
            .collect();
        let text = index(&skills, &none());
        assert_eq!(
            text.lines().filter(|l| l.starts_with("- skill-")).count(),
            INDEX_SKILLS
        );
        assert!(text.contains("and 5 more; find them with skill_search"));
        assert!(
            text.lines().all(|l| l.chars().count() < 200),
            "descriptions are cut short"
        );
    }

    #[test]
    fn the_index_favours_the_skills_this_bot_used_over_the_first_names() {
        let skills: Vec<SkillEntry> = (0..INDEX_SKILLS + 10)
            .map(|i| skill(&format!("skill-{i:03}"), "x", false))
            .collect();
        let uses = HashMap::from([
            (
                "skill-049".to_owned(),
                Use {
                    loads: 9,
                    helpful: false,
                },
            ),
            (
                "skill-045".to_owned(),
                Use {
                    loads: 2,
                    helpful: true,
                },
            ),
        ]);
        let text = index(&skills, &uses);
        let listed: Vec<&str> = text
            .lines()
            .filter_map(|l| l.strip_prefix("- "))
            .filter_map(|l| l.split(':').next())
            .collect();
        assert_eq!(&listed[..3], ["skill-049", "skill-045", "skill-000"]);
        assert!(!listed.contains(&"skill-039"), "the unused tail gave way");
        assert_eq!(
            index(&skills, &uses),
            text,
            "the same use gives the same bytes"
        );
    }

    #[test]
    fn a_name_match_ranks_above_a_description_above_a_body_above_nothing() {
        let skills = [
            with_body(
                "notes",
                "Keep notes",
                "Before you deploy, write it down.",
                false,
            ),
            skill("deploy", "Ship it", false),
            skill("release", "Deploy a release", false),
            skill("unrelated", "Something else", false),
        ];
        let found = search(&skills, "deploy", 8, &none());
        assert_eq!(names(&found), ["deploy", "release", "notes"]);
    }

    #[test]
    fn a_rare_word_counts_more_than_a_common_one() {
        let skills = [
            skill("pdf-tables", "Read tables from a document", false),
            skill("docx", "Write a document", false),
            skill("xlsx", "Edit a document", false),
            skill("slides", "Make a document", false),
        ];
        // `document` is everywhere; `tables` only in one, so it decides.
        let found = search(&skills, "document tables", 8, &none());
        assert_eq!(names(&found)[0], "pdf-tables");
    }

    #[test]
    fn equal_matches_go_to_the_skill_this_bot_found_helpful_then_loaded_more() {
        let skills = [
            skill("alpha-review", "Review code", false),
            skill("beta-review", "Review code", false),
            skill("gamma-review", "Review code", false),
        ];
        let uses = HashMap::from([
            (
                "gamma-review".to_owned(),
                Use {
                    loads: 1,
                    helpful: true,
                },
            ),
            (
                "beta-review".to_owned(),
                Use {
                    loads: 5,
                    helpful: false,
                },
            ),
        ]);
        let found = search(&skills, "review", 8, &uses);
        assert_eq!(
            names(&found),
            ["gamma-review", "beta-review", "alpha-review"]
        );
        assert_eq!(
            names(&search(&skills, "review", 8, &none())),
            ["alpha-review", "beta-review", "gamma-review"]
        );
    }

    #[test]
    fn search_finds_word_starts_leaves_out_manual_and_find_ignores_case() {
        let skills = [
            skill("review-code", "Look over a pull request", false),
            skill("open-pr", "Open a pull request with reviewers", false),
            skill("release", "Review and ship a release", true),
        ];
        let found = search(&skills, "review", 5, &none());
        assert_eq!(names(&found), ["review-code", "open-pr"]);
        assert!(
            search(&skills, "view", 5, &none()).is_empty(),
            "word starts only"
        );
        assert_eq!(
            find(&skills, "Review-Code").map(|s| s.id.as_str()),
            Some("skl_review-code")
        );
        assert_eq!(find(&skills, "release"), None);
    }
}
