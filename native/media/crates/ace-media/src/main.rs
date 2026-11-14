// SPDX-License-Identifier: Apache-2.0
use std::io::{self, Write};

const VERSION: &str = match option_env!("ACE_MEDIA_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        let _ = writeln!(io::stdout().lock(), "{VERSION}");
        return;
    }
    // Before any secret can arrive: no payload in a panic message, no core dump.
    media_noise::install_payload_free_panic_hook();
    ace_media::os::harden();
    std::process::exit(run());
}

#[cfg(unix)]
fn run() -> i32 {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build();
    match runtime {
        Ok(runtime) => runtime.block_on(ace_media::shell::run(VERSION)),
        Err(_) => 1,
    }
}

/// The Windows lanes (named pipes with a current-user ACL) are not built yet.
#[cfg(not(unix))]
fn run() -> i32 {
    eprintln!("ace-media: this platform is not supported yet");
    1
}
