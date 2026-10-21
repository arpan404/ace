//! Naming an app: exact id or name first, then a single partial match. Pure.
use crate::computer::error::{CuError, CuResult};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    pub name: String,
    pub running: bool,
}

fn exact(candidate: &Candidate, wanted: &str) -> bool {
    let id = candidate.id.to_lowercase();
    id == wanted || candidate.name.to_lowercase() == wanted || id.rsplit('.').next() == Some(wanted) && id.contains('.')
}

fn partial(candidate: &Candidate, wanted: &str) -> bool {
    candidate.name.to_lowercase().contains(wanted) || candidate.id.to_lowercase().contains(wanted)
}

/// Running apps are listed before installed ones; an app both running and installed is one
/// candidate (its running entry).
pub fn resolve(query: &str, candidates: &[Candidate]) -> CuResult<Candidate> {
    let wanted = query.trim().to_lowercase();
    if wanted.is_empty() {
        return Err(CuError::new(
            "app_not_found",
            "Name an app, e.g. \"Calculator\" or \"org.gnome.TextEditor\".",
        ));
    }
    let mut unique: Vec<&Candidate> = Vec::new();
    for candidate in candidates {
        if !unique.iter().any(|c| c.id == candidate.id) {
            unique.push(candidate);
        }
    }
    if let Some(found) = unique
        .iter()
        .find(|c| c.running && exact(c, &wanted))
        .or_else(|| unique.iter().find(|c| exact(c, &wanted)))
    {
        return Ok((*found).clone());
    }
    let matches: Vec<&&Candidate> = unique.iter().filter(|c| partial(c, &wanted)).collect();
    match matches.as_slice() {
        [] => Err(CuError::new(
            "app_not_found",
            format!(
                "No installed app matches \"{query}\". Call screen_apps with a shorter query to see what is installed."
            ),
        )),
        [only] => Ok((**only).clone()),
        many => {
            let listed: Vec<String> = many.iter().take(12).map(|c| format!("{} ({})", c.name, c.id)).collect();
            Err(CuError::new(
                "app_ambiguous",
                format!(
                    "\"{query}\" matches several apps: {}. Pass the exact name or app id.",
                    listed.join(", ")
                ),
            ))
        }
    }
}

/// `apps {query}`: running apps that match, then up to 50 installed ones (none without a query).
pub fn listing(query: Option<&str>, running: &[Candidate], installed: &[Candidate]) -> Vec<Candidate> {
    let wanted = query.map(|q| q.trim().to_lowercase()).unwrap_or_default();
    let matches = |c: &Candidate| wanted.is_empty() || partial(c, &wanted);
    let mut rows: Vec<Candidate> = running.iter().filter(|c| matches(c)).cloned().collect();
    if wanted.is_empty() {
        return rows;
    }
    let mut extra: Vec<Candidate> = installed
        .iter()
        .filter(|c| matches(c) && !running.iter().any(|r| r.id == c.id))
        .cloned()
        .collect();
    extra.sort_by_key(|c| c.name.to_lowercase());
    extra.dedup_by(|a, b| a.id == b.id);
    rows.extend(extra.into_iter().take(50));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(id: &str, name: &str, running: bool) -> Candidate {
        Candidate {
            id: id.into(),
            name: name.into(),
            running,
        }
    }

    fn world() -> Vec<Candidate> {
        vec![
            candidate("org.gnome.Calculator", "Calculator", true),
            candidate("org.gnome.TextEditor", "Text Editor", false),
            candidate("org.xfce.mousepad", "Mousepad", false),
            candidate("org.gnome.Calculator", "Calculator", false),
        ]
    }

    #[test]
    fn exact_ids_names_and_short_ids_resolve_case_insensitively() {
        assert_eq!(resolve("calculator", &world()).unwrap().id, "org.gnome.Calculator");
        assert!(resolve("calculator", &world()).unwrap().running);
        assert_eq!(
            resolve("ORG.GNOME.TEXTEDITOR", &world()).unwrap().id,
            "org.gnome.TextEditor"
        );
        assert_eq!(resolve("texteditor", &world()).unwrap().id, "org.gnome.TextEditor");
    }

    #[test]
    fn a_single_partial_match_resolves_and_several_are_listed() {
        assert_eq!(resolve("mouse", &world()).unwrap().id, "org.xfce.mousepad");
        let error = resolve("org.gnome", &world()).unwrap_err();
        assert_eq!(error.code, "app_ambiguous");
        assert!(
            error
                .message
                .contains("Calculator (org.gnome.Calculator), Text Editor (org.gnome.TextEditor)")
        );
        assert_eq!(resolve("photoshop", &world()).unwrap_err().code, "app_not_found");
    }

    #[test]
    fn listing_shows_installed_apps_only_for_a_query() {
        let running = vec![candidate("org.gnome.Calculator", "Calculator", true)];
        let installed = world()
            .into_iter()
            .map(|c| Candidate { running: false, ..c })
            .collect::<Vec<_>>();
        assert_eq!(listing(None, &running, &installed).len(), 1);
        let found = listing(Some("o"), &running, &installed);
        assert_eq!(
            found.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            vec!["org.gnome.Calculator", "org.xfce.mousepad", "org.gnome.TextEditor"]
        );
    }
}
