#[cfg(windows)]
fn main() {
    use ace_screen_helper_windows::{codec, windows::Host};
    let result = (|| {
        let args: Vec<String> = std::env::args().collect();
        if args.len() != 3 || args[1] != "--endpoint" {
            return Err(ace_screen_helper_windows::errors::Error::new(
                ace_screen_helper_windows::errors::Code::Bounds,
                "Usage: ace-screen-helper-windows --endpoint pipe:<local-name>",
            ));
        }
        let mut host = Host::open(&args[2])?;
        let stdin = std::io::stdin();
        let mut input = stdin.lock();
        let stdout = std::io::stdout();
        let mut output = stdout.lock();
        while let Some(line) = codec::read_line(&mut input)? {
            let request = codec::Request::decode(&line)?;
            codec::reply(&mut output, &request, host.command(&request))?;
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
