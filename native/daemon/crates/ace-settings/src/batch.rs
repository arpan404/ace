// SPDX-License-Identifier: Apache-2.0
//! What a `settings.setMany` batch may contain (`batch.ts` and the daemon's rule). The
//! shape and placement rules are [`crate::layers::check_batch`]'s; a setting the daemon
//! handles on its own never joins a batch.

pub use crate::layers::Layer;
use crate::validation::{SettingsCode, SettingsError};

/// Settings the daemon handles on their own when written: a batch never includes them.
pub fn set_on_its_own(key: &str) -> bool {
    key == "projects.roots"
        || key.starts_with("browser.download")
        || key.starts_with("host.")
        || key.starts_with("remote.")
}

/// A batch failure: a whole-batch rule, or a rejected value.
#[derive(Debug, Clone, PartialEq)]
pub enum BatchError<E> {
    /// A batch shape, key or placement refusal.
    Settings(SettingsError),
    /// A value the setting will not take.
    Validation(E),
}

impl<E> BatchError<E> {
    /// The message a caller shows.
    pub fn message(&self) -> &str {
        match self {
            Self::Settings(error) => &error.message,
            Self::Validation(_) => "Invalid value",
        }
    }
}

/// Applies a whole batch or nothing: every entry placed and validated first, then one
/// `commit` with all entries, so subscribers see one change.
pub fn apply_batch<K, V, E>(
    entries: &[(K, V)],
    layer: &Layer,
    mut validate: impl FnMut(&K, &V) -> Result<(), E>,
    commit: impl FnOnce(&[(K, V)]),
) -> Result<(), BatchError<E>>
where
    K: AsRef<str>,
    V: Clone,
{
    let keys: Vec<&str> = entries.iter().map(|(key, _)| key.as_ref()).collect();
    crate::layers::check_batch(keys, layer).map_err(BatchError::Settings)?;
    for (key, value) in entries {
        validate(key, value).map_err(BatchError::Validation)?;
    }
    commit(entries);
    Ok(())
}

/// The daemon's refusal for a batch that mixes a setting it handles itself.
pub fn on_its_own(key: &str) -> SettingsError {
    SettingsError::new(
        SettingsCode::Validation,
        &format!("Set {key} on its own, not with others"),
    )
}

#[cfg(test)]
mod tests {
    //! Ports `packages/settings/src/set-many.test.ts` and `apps/daemon/src/settings.ts:179`:
    //! "a batch with one value the setting won't take writes none of it", "a batch on a layer
    //! one of its settings can't live on writes none of it", and a setting the daemon
    //! handles itself never joins a batch.

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
            &Layer::Global,
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
        let result = apply_batch(
            &[("providers.coder.provider", "claude")],
            &Layer::Workspace {
                workspace: std::path::PathBuf::from("/workspace"),
            },
            |_, _| Ok::<(), ()>(()),
            |_| panic!("nothing commits"),
        );
        assert_eq!(
            result.map_err(|error| error.message().to_owned()),
            Err("Roles are a global setting".into())
        );
    }

    #[test]
    fn a_duplicate_key_is_a_validation_refusal_as_a_single_write_would_be() {
        let result = apply_batch(
            &[("threads.sortBy", "manual"), ("threads.sortBy", "created")],
            &Layer::Global,
            |_, _| Ok::<(), ()>(()),
            |_| panic!("nothing commits"),
        );
        match result {
            Err(BatchError::Settings(error)) => {
                assert_eq!(error.code, SettingsCode::Validation);
                assert_eq!(error.message, "Each setting can be set once per change");
            }
            other => panic!("{other:?}"),
        }
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
        assert_eq!(
            on_its_own("remote.enabled").message,
            "Set remote.enabled on its own, not with others"
        );
    }
}
