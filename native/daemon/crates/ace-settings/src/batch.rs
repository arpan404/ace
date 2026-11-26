// SPDX-License-Identifier: Apache-2.0
//! What a `settings.setMany` batch may contain and where a setting may live
//! (`batch.ts`, and the layer rules from `service.ts`).

/// Settings the daemon handles on their own when written: a batch never includes them.
pub fn set_on_its_own(key: &str) -> bool {
    key == "projects.roots"
        || key.starts_with("browser.download")
        || key.starts_with("host.")
        || key.starts_with("remote.")
}

/// A settings layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layer {
    Global,
    Workspace,
    Thread,
}

/// Whether `key` may be written on `layer`, with the TypeScript's own refusal.
pub fn placement(key: &str, layer: Layer) -> Result<(), &'static str> {
    let layer = match layer {
        Layer::Global => crate::layers::Layer::Global,
        Layer::Workspace => crate::layers::Layer::Workspace {
            workspace: std::path::PathBuf::from("/workspace"),
        },
        Layer::Thread => crate::layers::Layer::Thread {
            thread: "thread".to_owned(),
        },
    };
    crate::layers::placement(key, &layer).map_err(|error| match error.message.as_str() {
        "Roles are a global setting" => "Roles are a global setting",
        "Project folders are a global user setting" => "Project folders are a global user setting",
        "Provider configuration is a global user setting" => {
            "Provider configuration is a global user setting"
        }
        "The downloads folder is a global daemon setting" => {
            "The downloads folder is a global daemon setting"
        }
        "Apps agents can't use is a global setting" => "Apps agents can't use is a global setting",
        "Running Spade is a global setting" => "Running Spade is a global setting",
        "Beta features are a global setting" => "Beta features are a global setting",
        "Working while this Mac is locked is a global setting" => {
            "Working while this Mac is locked is a global setting"
        }
        "Generation settings belong to the daemon" => "Generation settings belong to the daemon",
        _ => "Settings cannot live on this layer",
    })
}

/// A batch failure: a setting on a layer that cannot hold it, or a rejected value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchError<E> {
    Placement(&'static str),
    Validation(E),
    Limit(&'static str),
}

/// Applies a whole batch or nothing: 1 to 32 unique keys, every entry placed and
/// validated first, then one `commit` with all entries, so subscribers see one change.
pub fn apply_batch<K, V, E>(
    entries: &[(K, V)],
    layer: Layer,
    mut validate: impl FnMut(&K, &V) -> Result<(), E>,
    commit: impl FnOnce(&[(K, V)]),
) -> Result<(), BatchError<E>>
where
    K: AsRef<str>,
    V: Clone,
{
    if entries.is_empty() || entries.len() > 32 {
        return Err(BatchError::Limit("Set between 1 and 32 settings at once"));
    }
    let mut seen = Vec::new();
    for (key, _) in entries {
        let key = key.as_ref();
        if seen.contains(&key) {
            return Err(BatchError::Limit("Each setting can be set once per change"));
        }
        seen.push(key);
        placement(key, layer).map_err(BatchError::Placement)?;
    }
    for (key, value) in entries {
        validate(key, value).map_err(BatchError::Validation)?;
    }
    commit(entries);
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Ports `packages/settings/src/set-many.test.ts`: "a batch with one value the
    //! setting won't take writes none of it" and "a batch on a layer one of its
    //! settings can't live on writes none of it" (the atomicity rule, at the crate's
    //! boundary).

    use super::*;

    #[test]
    fn a_batch_with_one_value_the_setting_will_not_take_writes_none_of_it() {
        let entries = [
            ("providers.coder.model", "claude-opus-5-5"),
            ("providers.coder.provider", "claude"),
            ("providers.coder.reasoningEffort", "enormous"),
        ];
        let mut store = std::collections::BTreeMap::new();
        let result = apply_batch(
            &entries,
            Layer::Global,
            |_, value| {
                if *value == "enormous" {
                    Err("Invalid value")
                } else {
                    Ok(())
                }
            },
            |entries: &[(&str, &str)]| {
                for (key, value) in entries {
                    store.insert((*key).to_string(), (*value).to_string());
                }
            },
        );
        assert_eq!(result, Err(BatchError::Validation("Invalid value")));
        assert!(store.is_empty());
    }

    #[test]
    fn a_batch_on_a_layer_one_of_its_settings_cannot_live_on_writes_none_of_it() {
        assert_eq!(
            placement("providers.coder.provider", Layer::Workspace),
            Err("Roles are a global setting")
        );
        assert!(placement("providers.coder.provider", Layer::Global).is_ok());
        assert_eq!(
            placement("projects.roots", Layer::Thread),
            Err("Project folders are a global user setting")
        );
    }

    #[test]
    fn settings_the_daemon_handles_itself_never_join_a_batch() {
        for key in [
            "projects.roots",
            "browser.downloadDir",
            "host.displayName",
            "remote.transport",
        ] {
            assert!(set_on_its_own(key), "{key}");
        }
        assert!(!set_on_its_own("threads.followUpBehavior"));
    }
}
