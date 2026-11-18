//! `spade --help` and unknown arguments, as a person typing at a shell meets them: the real
//! binary prints usage and exits without starting a server or creating anything.

use std::process::Command;
use std::time::{Duration, Instant};

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

/// Runs the binary in a throwaway home; returns its output and whether the home stayed empty.
fn run(args: &[&str]) -> Result<(std::process::Output, bool, Duration)> {
    let home = tempfile::tempdir()?;
    let started = Instant::now();
    let output = Command::new(env!("CARGO_BIN_EXE_spade"))
        .args(args)
        .current_dir(home.path())
        .env("HOME", home.path())
        .env("SPADE_DATA_DIR", home.path().join("data"))
        .env("SPADE_ACE_HOME", home.path().join("ace"))
        // A server would bind a port and block; this makes a wrongly started one visible.
        .env("SPADE_LISTEN", "127.0.0.1:0")
        .output()?;
    let elapsed = started.elapsed();
    let untouched = std::fs::read_dir(home.path())?.next().is_none();
    Ok((output, untouched, elapsed))
}

#[test]
fn help_prints_usage_and_exits_without_starting_a_server() -> Result {
    for flag in ["--help", "-h"] {
        let (output, untouched, elapsed) = run(&[flag])?;
        assert_eq!(output.status.code(), Some(0), "{flag}");
        let text = String::from_utf8_lossy(&output.stdout);
        assert!(text.contains("usage: spade"), "{flag}: {text}");
        assert!(untouched, "{flag} created files");
        assert!(elapsed < Duration::from_secs(10), "{flag} took {elapsed:?}");
    }
    Ok(())
}

#[test]
fn an_unknown_flag_prints_usage_on_stderr_and_fails_without_starting_a_server() -> Result {
    let (output, untouched, elapsed) = run(&["--frobnicate"])?;
    assert_eq!(output.status.code(), Some(2));
    let text = String::from_utf8_lossy(&output.stderr);
    assert!(text.contains("unknown argument --frobnicate"), "{text}");
    assert!(text.contains("usage: spade"), "{text}");
    assert!(untouched, "an unknown flag created files");
    assert!(elapsed < Duration::from_secs(10), "took {elapsed:?}");
    Ok(())
}
