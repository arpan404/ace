#[cfg(windows)]
fn main() {
    use ace_screen_helper_windows::{codec, windows::Host};
    // `--computer [--data-dir <dir>]`: the agent computer-use engine on stdin and stdout.
    if std::env::args().nth(1).as_deref() == Some("--computer") {
        std::process::exit(ace_screen_helper_windows::computer::run());
    }
    let result = (|| {
        let args: Vec<String> = std::env::args().collect();
        if args.len() != 3 || args[1] != "--endpoint" {
            return Err(ace_screen_helper_windows::errors::Error::new(
                ace_screen_helper_windows::errors::Code::Bounds,
                "Usage: ace-screen-helper-windows --endpoint pipe:<local-name>",
            ));
        }
        let mut host = Host::open(&args[2], || {
            // Stands in for an N edition without the Media Feature Pack, for tests of the
            // last-resort path on machines that have an MFT.
            if std::env::var_os("ACE_SCREEN_HELPER_NO_MFT").is_some() {
                return ace_screen_helper_windows::media::capability::Trial::failed(
                    "Media Foundation encoders hidden by ACE_SCREEN_HELPER_NO_MFT",
                );
            }
            ace_screen_helper_windows::windows::trial::run()
        })?;
        let stdin = std::io::stdin();
        let mut input = stdin.lock();
        while let Some(line) = codec::read_line(&mut input)? {
            let request = codec::Request::decode(&line)?;
            let result = host.command(&request);
            // Locked per reply: capture threads write events between replies.
            codec::reply(&mut std::io::stdout().lock(), &request, result)?;
        }
        Ok::<(), ace_screen_helper_windows::errors::Error>(())
    })();
    if let Err(error) = result {
        eprintln!("screen-helper: {error}");
        std::process::exit(1);
    }
}
#[cfg(not(windows))]
fn main() {
    eprintln!("Windows runtime required; use cargo test for host logic");
    std::process::exit(2);
}
