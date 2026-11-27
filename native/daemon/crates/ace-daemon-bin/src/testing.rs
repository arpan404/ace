// SPDX-License-Identifier: Apache-2.0
//! Test-only switches, read only by a debug build: a release daemon ignores
//! every `ACE_TEST_*` seam, so a stray variable cannot weaken a shipped one.

/// `ACE_TEST_*`: none in a release build.
pub fn var(name: &str) -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var(name).ok()
}
