//! The skill index a conversation starts with, and skill search. Pure: the engine fetches the
//! person's skill library and passes it in.

/// A skill as Spade offers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Only the person starts it; never listed for the model to load on its own.
    pub manual: bool,
}

/// The most skills the index lists by name; the rest are found with `skill_search`.
pub const INDEX_SKILLS: usize = 40;
/// The longest description the index keeps, in characters.
const INDEX_DESCRIPTION: usize = 160;

/// The index frozen into the conversation's instructions at its first step: skills by name with
/// a short description, in name order so the same library gives the same bytes.
pub fn index(skills: &[SkillEntry]) -> String {
    let mut offered: Vec<&SkillEntry> = skills.iter().filter(|s| !s.manual).collect();
    if offered.is_empty() {
        return String::new();
    }
    offered.sort_by(|a, b| a.name.cmp(&b.name));
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

/// Skills matching `query`, best first, at most `limit`. Words of three letters or more are
/// looked for in the name and description; the name counts double. Manual skills are left out.
pub fn search<'a>(skills: &'a [SkillEntry], query: &str, limit: usize) -> Vec<&'a SkillEntry> {
    let words: Vec<String> = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 3)
        .map(str::to_lowercase)
        .collect();
    let mut scored: Vec<(usize, &SkillEntry)> = skills
        .iter()
        .filter(|s| !s.manual)
        .filter_map(|skill| {
            let name = skill.name.to_lowercase();
            let about = skill.description.to_lowercase();
            let score: usize = words
                .iter()
                .map(|w| {
                    2 * usize::from(name.contains(w.as_str()))
                        + usize::from(about.contains(w.as_str()))
                })
                .sum();
            (score > 0).then_some((score, skill))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
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
        SkillEntry {
            id: format!("skl_{name}"),
            name: name.into(),
            description: description.into(),
            manual,
        }
    }

    #[test]
    fn the_index_lists_skills_by_name_and_leaves_out_manual_ones() {
        let skills = [
            skill("review-code", "Review a branch or PR", false),
            skill("deploy", "Ship to production", true),
            skill("open-pr", "Open a pull request", false),
        ];
        let text = index(&skills);
        assert!(
            text.ends_with(
                "- open-pr: Open a pull request\n- review-code: Review a branch or PR\n"
            ),
            "{text}"
        );
        assert!(!text.contains("deploy"));
        assert_eq!(index(&[]), "");
    }

    #[test]
    fn a_big_library_is_capped_and_points_to_search() {
        let skills: Vec<SkillEntry> = (0..INDEX_SKILLS + 5)
            .map(|i| skill(&format!("skill-{i:03}"), &"long words ".repeat(40), false))
            .collect();
        let text = index(&skills);
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
    fn search_ranks_name_matches_first_and_find_ignores_case_but_not_manual() {
        let skills = [
            skill("review-code", "Look over a pull request", false),
            skill(
                "open-pr",
                "Open a pull request with a review checklist",
                false,
            ),
            skill("release", "Review and ship a release", true),
        ];
        let found: Vec<&str> = search(&skills, "review", 5)
            .iter()
            .map(|s| s.name.as_str())
            .collect();
        assert_eq!(found, vec!["review-code", "open-pr"]);
        assert_eq!(
            find(&skills, "Review-Code").map(|s| s.id.as_str()),
            Some("skl_review-code")
        );
        assert_eq!(find(&skills, "release"), None);
    }
}
