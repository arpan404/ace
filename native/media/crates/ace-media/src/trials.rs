// SPDX-License-Identifier: Apache-2.0
//! The last-resort Chrome encoder's trial (E4): tried after `ready`, and only when no hardware
//! encoder this build can construct worked (`encode::select::last_resort_needed`). The start
//! trials are `probe::trials`.
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
    crate::encode::select::last_resort_needed(probed, crate::encode::platform::BUILT_ENCODERS)
        .then(|| media_chrome::ChromeOptions::new(executable, profile_root.to_path_buf()))
}

/// The Chrome encoder's trial, on a thread of its own: its result arrives late, as
/// `capabilities.changed`.
pub fn chrome_trial(
    options: media_chrome::ChromeOptions,
    deadline: Duration,
    cancel: &crate::probe::Cancel,
    done: impl FnOnce(Capability) + Send + 'static,
) {
    let cancel = cancel.flag();
    let _ = std::thread::Builder::new()
        .name("probe-chrome".into())
        .spawn(move || {
            done(media_chrome::probe(options, deadline, cancel));
        });
}
