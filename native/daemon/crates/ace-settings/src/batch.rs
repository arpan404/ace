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

/// Whether `key` may be written on `layer`: roles are global-only.
pub fn placement(key: &str, layer: Layer) -> Result<(), &'static str> {
    if layer != Layer::Global && crate::roles::role_setting(key) {
        return Err("Roles are a global setting");
    }
    if layer == Layer::Thread && key.starts_with("projects.") {
        return Err("Project settings are a global or workspace setting");
    }
    Ok(())
}

/// A batch failure: a setting on a layer that cannot hold it, or a rejected value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchError<E> {
    Placement(&'static str),
    Validation(E),
}

/// Applies a whole batch or nothing: every entry is placed and validated first, then
/// `commit` runs once per entry. A failure leaves the store untouched.
pub fn apply_batch<K, V, E>(
    entries: &[(K, V)],
    layer: Layer,
    mut validate: impl FnMut(&K, &V) -> Result<(), E>,
    mut commit: impl FnMut(&K, V),
) -> Result<(), BatchError<E>>
where
    K: AsRef<str>,
    V: Clone,
{
    for (key, _) in entries {
        placement(key.as_ref(), layer).map_err(BatchError::Placement)?;
    }
    for (key, value) in entries {
        validate(key, value).map_err(BatchError::Validation)?;
    }
    for (key, value) in entries {
        commit(key, value.clone());
    }
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
            |key, value| {
                store.insert(key.to_string(), value.to_string());
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
            Err("Project settings are a global or workspace setting")
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
