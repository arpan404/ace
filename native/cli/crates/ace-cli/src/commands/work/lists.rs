// SPDX-License-Identifier: Apache-2.0
//! List lines for ported work reads (project + request lists).

use std::collections::BTreeMap;

use super::render::{format_age, paint, request_glyph, request_kind, request_sentence, short_ids};

/// `ace project list` human lines.
pub fn project_list_lines(projects: &serde_json::Value, next: Option<&str>) -> Vec<String> {
    let empty = Vec::new();
    let list = projects.as_array().unwrap_or(&empty);
    if list.is_empty() {
        return vec!["No projects yet. Add this folder with ace project add.".to_owned()];
    }
    let name_width = list
        .iter()
        .map(|p| {
            p.get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .len()
        })
        .max()
        .unwrap_or(0)
        .min(24);
    let id_width = list
        .iter()
        .map(|p| {
            p.get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .len()
        })
        .max()
        .unwrap_or(0);
    let mut lines: Vec<String> = list
        .iter()
        .map(|p| {
            let name = p
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let id = p
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let path = p
                .get("path")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            format!("{name:<name_width$}  {id:<id_width$}  {path}")
        })
        .collect();
    if let Some(next) = next {
        lines.push(format!("More: ace project list --after {next}"));
    }
    lines
}

/// `ace request list` human lines.
pub fn request_list_lines(
    list: &serde_json::Value,
    now: i64,
    colour: bool,
    project_names: &BTreeMap<String, String>,
) -> Vec<String> {
    let requests = list
        .get("requests")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    if requests.is_empty() {
        return vec!["Nothing needs you.".to_owned()];
    }
    let ids: Vec<String> = requests
        .iter()
        .filter_map(|r| {
            r.get("interaction")
                .and_then(|i| i.get("id"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    let short = short_ids(&ids, 8);
    let id_width = ids
        .iter()
        .map(|id| short.get(id).map_or(0, String::len))
        .max()
        .unwrap_or(0);
    let mut lines = Vec::new();
    for each in &requests {
        let interaction = each.get("interaction").cloned().unwrap_or_default();
        let id = interaction
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let short_id = short.get(id).map_or(id, String::as_str);
        let kind = request_kind(each);
        let glyph = paint(request_glyph(kind), "needs-you", colour);
        let sentence = request_sentence(&interaction);
        let workspace = each
            .get("workspaceId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let project = project_names.get(workspace).map_or("", String::as_str);
        let title = each
            .get("threadTitle")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let location = [project, title]
            .iter()
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(" · ");
        let created = interaction
            .get("createdAt")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(now);
        let age = format_age(created, now);
        lines.push(format!(
            "{glyph} {short_id:<id_width$}  {sentence}   {location}  {age}",
        ));
    }
    let truncated = list
        .get("truncated")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if truncated {
        lines.push("More are open; answer these first, or narrow with --thread.".to_owned());
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::super::render::{format_age, short_ids};
    use super::project_list_lines;

    #[test]
    fn ages_are_compact_and_never_future() {
        assert_eq!(format_age(1_000, 1_000), "now");
        assert_eq!(format_age(0, 120_000), "2m");
        assert_eq!(format_age(0, 3 * 3_600_000), "3h");
    }

    #[test]
    fn short_ids_are_unique_prefixes() {
        let ids = vec!["i_abc12345".to_owned(), "i_abc67890".to_owned()];
        let short = short_ids(&ids, 8);
        assert_eq!(short.len(), 2);
        assert!(short.values().all(|s| s.len() >= 8));
    }

    #[test]
    fn empty_projects_name_the_add_command() {
        let empty = serde_json::Value::Array(Vec::new());
        assert_eq!(
            project_list_lines(&empty, None),
            vec!["No projects yet. Add this folder with ace project add."]
        );
    }
}
