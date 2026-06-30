use super::ToolRegistryEntryProjection;

#[derive(Debug, Clone, Copy)]
pub(super) enum RegistrySurface {
    Plugin,
    Skill,
}

pub(super) fn parse_tool_registry_entries(
    value: serde_json::Value,
    surface: RegistrySurface,
) -> Vec<ToolRegistryEntryProjection> {
    let mut entries = Vec::new();
    collect_tool_registry_entries(&value, surface, &mut entries);
    let mut unique = Vec::new();
    for entry in entries {
        if !unique
            .iter()
            .any(|existing: &ToolRegistryEntryProjection| existing.id == entry.id)
        {
            unique.push(entry);
        }
    }
    unique
}

fn collect_tool_registry_entries(
    value: &serde_json::Value,
    surface: RegistrySurface,
    entries: &mut Vec<ToolRegistryEntryProjection>,
) {
    match value {
        serde_json::Value::Array(items) => {
            entries.extend(
                items
                    .iter()
                    .filter_map(|item| parse_tool_registry_entry(item, surface, None)),
            );
        }
        serde_json::Value::Object(object) => {
            for key in registry_list_keys(surface) {
                if let Some(nested) = object.get(*key) {
                    collect_tool_registry_entries(nested, surface, entries);
                    return;
                }
            }
            if let Some(entry) = parse_tool_registry_entry(value, surface, None) {
                entries.push(entry);
                return;
            }
            entries.extend(object.iter().filter_map(|(key, nested)| {
                parse_tool_registry_entry(nested, surface, Some(key.as_str()))
            }));
        }
        serde_json::Value::String(name) => {
            entries.push(simple_tool_registry_entry(name));
        }
        _ => {}
    }
}

fn registry_list_keys(surface: RegistrySurface) -> &'static [&'static str] {
    match surface {
        RegistrySurface::Plugin => &[
            "plugins",
            "installed_plugins",
            "installedPlugins",
            "installed",
            "items",
            "entries",
            "results",
        ],
        RegistrySurface::Skill => &[
            "skills",
            "installed_skills",
            "installedSkills",
            "items",
            "entries",
            "results",
        ],
    }
}

fn parse_tool_registry_entry(
    value: &serde_json::Value,
    surface: RegistrySurface,
    fallback_id: Option<&str>,
) -> Option<ToolRegistryEntryProjection> {
    match value {
        serde_json::Value::String(name) => Some(simple_tool_registry_entry(name)),
        serde_json::Value::Object(object) => {
            let name = string_field(
                object,
                match surface {
                    RegistrySurface::Plugin => &[
                        "display_name",
                        "displayName",
                        "name",
                        "title",
                        "plugin",
                        "id",
                    ],
                    RegistrySurface::Skill => &[
                        "display_name",
                        "displayName",
                        "name",
                        "title",
                        "skill",
                        "id",
                    ],
                },
            )
            .or_else(|| fallback_id.map(ToString::to_string))?;
            let id = string_field(object, &["id", "slug", "key"])
                .or_else(|| fallback_id.map(ToString::to_string))
                .unwrap_or_else(|| name.clone());
            let enabled = object.get("enabled").and_then(serde_json::Value::as_bool);
            let status =
                string_field(object, &["status", "state", "health"]).unwrap_or_else(|| {
                    enabled.map_or_else(
                        || "available".to_string(),
                        |enabled| {
                            if enabled {
                                "enabled".to_string()
                            } else {
                                "disabled".to_string()
                            }
                        },
                    )
                });

            Some(ToolRegistryEntryProjection {
                id,
                name,
                description: string_field(object, &["description", "summary"]),
                version: string_field(object, &["version"]),
                source: string_field(object, &["source", "origin"]),
                status,
                enabled,
                disabled_reason: registry_entry_disabled_reason(object, enabled),
            })
        }
        _ => None,
    }
}

fn simple_tool_registry_entry(name: &str) -> ToolRegistryEntryProjection {
    ToolRegistryEntryProjection {
        id: name.to_string(),
        name: name.to_string(),
        description: None,
        version: None,
        source: None,
        status: "available".to_string(),
        enabled: None,
        disabled_reason: None,
    }
}

pub(super) fn registry_entry_available(entry: &ToolRegistryEntryProjection) -> bool {
    if entry.enabled == Some(false) || entry.disabled_reason.is_some() {
        return false;
    }

    !matches!(
        entry.status.to_ascii_lowercase().as_str(),
        "disabled" | "unavailable" | "missing" | "error" | "failed"
    )
}

fn registry_entry_disabled_reason(
    object: &serde_json::Map<String, serde_json::Value>,
    enabled: Option<bool>,
) -> Option<String> {
    string_field(
        object,
        &[
            "disabled_reason",
            "disabledReason",
            "unavailable_reason",
            "unavailableReason",
            "last_error",
            "lastError",
            "error",
        ],
    )
    .or_else(|| {
        (enabled == Some(false)).then(|| {
            "This registry entry is disabled by the host runtime and cannot be attached to composer turns.".to_string()
        })
    })
}

fn string_field(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(serde_json::Value::as_str))
        .map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_registry_parser_reads_common_shapes() {
        let plugins = parse_tool_registry_entries(
            serde_json::json!({
                "installedPlugins": [
                    {
                        "id": "browser",
                        "displayName": "Browser",
                        "description": "Chromium control",
                        "version": "1.2.3",
                        "source": "builtin",
                        "enabled": true
                    },
                    "browser"
                ]
            }),
            RegistrySurface::Plugin,
        );
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].id, "browser");
        assert_eq!(plugins[0].name, "Browser");
        assert_eq!(plugins[0].status, "enabled");
        assert_eq!(plugins[0].disabled_reason, None);

        let skills = parse_tool_registry_entries(
            serde_json::json!({
                "rust": {
                    "description": "Rust workflow context",
                    "state": "disabled",
                    "disabledReason": "Project skills are disabled for this workspace."
                }
            }),
            RegistrySurface::Skill,
        );
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "rust");
        assert_eq!(skills[0].name, "rust");
        assert_eq!(skills[0].status, "disabled");
        assert_eq!(
            skills[0].disabled_reason.as_deref(),
            Some("Project skills are disabled for this workspace.")
        );
    }

    #[test]
    fn registry_availability_rejects_disabled_and_error_entries() {
        let available = ToolRegistryEntryProjection {
            id: "github".to_string(),
            name: "github".to_string(),
            description: None,
            version: None,
            source: None,
            status: "available".to_string(),
            enabled: None,
            disabled_reason: None,
        };
        let disabled = ToolRegistryEntryProjection {
            status: "available".to_string(),
            enabled: Some(false),
            disabled_reason: None,
            ..available.clone()
        };
        let errored = ToolRegistryEntryProjection {
            status: "error".to_string(),
            ..available.clone()
        };

        assert!(registry_entry_available(&available));
        assert!(!registry_entry_available(&disabled));
        assert!(!registry_entry_available(&errored));
    }
}
