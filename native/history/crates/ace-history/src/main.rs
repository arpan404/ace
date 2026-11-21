// SPDX-License-Identifier: Apache-2.0

//! `ace-history`: the daemon's saved-history reader (ADR 0207).

fn main() {
    std::process::exit(ace_history::run());
}
