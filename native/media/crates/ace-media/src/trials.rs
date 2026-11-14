// SPDX-License-Identifier: Apache-2.0
//! The last-resort Chrome encoder's trial (E4): tried after `ready`, and only when no hardware
//! encoder's trial worked (`media_chrome::last_resort_needed`). The start trials are
//! `probe::trials`.
use media_wire::capability::Capability;
use std::time::Duration;

/// The Chrome encoder ace-media would run here, if it is needed and a Chrome is installed.
pub fn chrome_options(
    probed: &[Capability],
    data_dir: &std::path::Path,
    profile_root: &std::path::Path,
) -> Option<media_chrome::ChromeOptions> {
    let search = media_chrome::ChromeSearch::from_env(Some(data_dir.to_path_buf()));
    let executable = media_chrome::find_chrome(&search)?;
    (media_chrome::last_resort_needed(probed))
        .then(|| media_chrome::ChromeOptions::new(executable, profile_root.to_path_buf()))
}

/// The Chrome encoder's trial, on a thread of its own: its result arrives late, as
/// `capabilities.changed`.
pub fn chrome_trial(
    options: media_chrome::ChromeOptions,
    deadline: Duration,
    done: impl FnOnce(Capability) + Send + 'static,
) {
    let _ = std::thread::Builder::new()
        .name("probe-chrome".into())
        .spawn(move || {
            let cancel = std::sync::Arc::default();
            done(media_chrome::probe(options, deadline, cancel));
        });
}
