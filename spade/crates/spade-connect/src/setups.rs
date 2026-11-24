//! Setup steps for apps that sign in with the person's own client ID
//! (`spade/config/connector-setups.json`, ADR 0197): where to make the app at the maker, what to
//! paste, what to tick and which values to bring back. Shown on the app's "Use a client ID" path;
//! nothing here signs in.
//!
//! The step that needs the person's callback is marked, never written out: the callback carries
//! Spade's port, so the server fills it in as it lists the catalogue.

use serde::{Deserialize, Serialize};

use crate::catalogue::Entry;

/// A value the maker gives the person to type into Spade.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Given {
    ClientId,
    ClientSecret,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub text: String,
    /// The step where the person pastes their callback, shown beside it.
    #[serde(default)]
    pub redirect: bool,
}

/// One app's setup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppSetup {
    /// The catalogue entry it is for.
    #[serde(skip_serializing)]
    pub connector: String,
    /// The maker's console, or the maker's page that says where it is.
    #[serde(rename = "where")]
    pub console: String,
    #[serde(rename = "where_label")]
    pub console_label: String,
    pub steps: Vec<Step>,
    pub values: Vec<Given>,
    /// What the person ticks when the maker asks; empty when the maker decides.
    #[serde(default)]
    pub scopes: Vec<String>,
    /// The maker's page the steps were read from.
    pub source: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    #[allow(dead_code)]
    #[serde(default)]
    about: String,
    #[allow(dead_code)]
    checked: String,
    setups: Vec<AppSetup>,
}

/// The setups, by catalogue entry.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Setups(Vec<AppSetup>);

impl Setups {
    /// The setup for catalogue entry `connector`, if it ships one.
    pub fn get(&self, connector: &str) -> Option<&AppSetup> {
        self.0.iter().find(|setup| setup.connector == connector)
    }
}

const SHIPPED: &str = include_str!("../../../config/connector-setups.json");

/// Reads a setups file, refused whole if a setup is for an app `catalogue` doesn't list, is there
/// twice, or doesn't mark exactly one step for the person's callback.
pub fn parse(text: &str, catalogue: &[Entry]) -> Result<Setups, String> {
    let file: File = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let mut seen = std::collections::HashSet::new();
    for setup in &file.setups {
        let id = setup.connector.as_str();
        if !catalogue.iter().any(|entry| entry.id == id) {
            return Err(format!("{id} is not in the catalogue"));
        }
        if !seen.insert(id) {
            return Err(format!("{id} has two setups"));
        }
        if !setup.console.starts_with("https://") || !setup.source.starts_with("https://") {
            return Err(format!("{id}: where and source must be https"));
        }
        if setup.steps.iter().filter(|step| step.redirect).count() != 1 {
            return Err(format!("{id}: exactly one step takes the redirect"));
        }
        if !setup.values.contains(&Given::ClientId) {
            return Err(format!("{id}: the maker always gives a client ID"));
        }
    }
    Ok(Setups(file.setups))
}

/// The shipped setups.
pub fn shipped() -> Setups {
    // Part of this build and checked by the test below, so it always reads.
    parse(SHIPPED, &crate::catalogue::shipped()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> Entry {
        Entry {
            id: id.into(),
            ..Entry::default()
        }
    }

    fn file(setup: &str) -> String {
        format!(r#"{{"checked":"2026-11-19","setups":[{setup}]}}"#)
    }

    const ASANA: &str = r#"{"connector":"asana","where":"https://app.asana.com/0/my-apps",
        "where_label":"Asana developer console",
        "steps":[{"text":"Make an app."},{"text":"Add this redirect:","redirect":true}],
        "values":["client_id","client_secret"],"source":"https://developers.asana.com"}"#;

    #[test]
    fn the_shipped_file_reads_against_the_shipped_catalogue() {
        let setups = parse(SHIPPED, &crate::catalogue::shipped()).unwrap_or_else(|e| panic!("{e}"));
        for id in ["asana", "box", "canva", "hubspot"] {
            assert!(setups.get(id).is_some(), "{id} has no setup");
        }
        assert_eq!(shipped(), setups);
    }

    #[test]
    fn a_setup_is_found_by_its_catalogue_entry() -> Result<(), String> {
        let setups = parse(&file(ASANA), &[entry("asana"), entry("box")])?;
        let asana = setups.get("asana").ok_or("no asana")?;
        assert_eq!(asana.console, "https://app.asana.com/0/my-apps");
        assert_eq!(asana.values, [Given::ClientId, Given::ClientSecret]);
        assert!(asana.steps[1].redirect && !asana.steps[0].redirect);
        assert!(setups.get("box").is_none());
        Ok(())
    }

    #[test]
    fn an_unknown_field_is_refused() {
        let typo = ASANA.replace(r#""where_label""#, r#""wher_label""#);
        assert!(parse(&file(&typo), &[entry("asana")]).is_err());
        let in_a_step = ASANA.replace(r#""redirect":true"#, r#""redirect":true,"copy":true"#);
        assert!(parse(&file(&in_a_step), &[entry("asana")]).is_err());
    }

    #[test]
    fn a_setup_for_an_app_the_catalogue_does_not_list_is_refused() {
        let refused = parse(&file(ASANA), &[entry("box")])
            .err()
            .unwrap_or_default();
        assert!(refused.contains("not in the catalogue"), "{refused}");
    }

    #[test]
    fn a_setup_needs_exactly_one_redirect_step() {
        for steps in [
            r#"[{"text":"Make an app."}]"#,
            r#"[{"text":"Here:","redirect":true},{"text":"And here:","redirect":true}]"#,
        ] {
            let setup = ASANA.replace(
                r#"[{"text":"Make an app."},{"text":"Add this redirect:","redirect":true}]"#,
                steps,
            );
            assert!(parse(&file(&setup), &[entry("asana")]).is_err(), "{steps}");
        }
    }
}
