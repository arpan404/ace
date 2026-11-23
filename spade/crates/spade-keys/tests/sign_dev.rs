//! `spade/scripts/sign-dev.sh` picks a stable identity for a local build (ADR 0119 amendment 1).
//! Runs the real script with fake `uname`, `security` and `codesign` on PATH, so no real
//! signing identity or keychain is touched.

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

fn script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/sign-dev.sh")
}

fn fake(dir: &Path, name: &str, body: &str) -> Result {
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n"))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    Ok(())
}

/// Runs the script with `identities` as what `security find-identity` lists. Returns its exit
/// status, its output, and the identity the fake `codesign` was asked to sign with, if any.
fn run(identities: &str) -> Result<(bool, String, Option<String>)> {
    let dir = tempfile::tempdir()?;
    let bin = dir.path().join("bin");
    std::fs::create_dir(&bin)?;
    let listing = dir.path().join("identities");
    std::fs::write(&listing, identities)?;
    let signed = dir.path().join("signed-with");
    fake(&bin, "uname", "echo Darwin")?;
    fake(&bin, "security", &format!("cat '{}'", listing.display()))?;
    fake(
        &bin,
        "codesign",
        &format!(
            "if [ \"$1\" = --force ]; then printf %s \"$3\" > '{}'; fi",
            signed.display()
        ),
    )?;
    let binary = dir.path().join("spade");
    std::fs::write(&binary, "not really a binary")?;
    let path = format!("{}:/usr/bin:/bin", bin.display());
    let out = Command::new("bash")
        .arg(script())
        .arg(&binary)
        .env("PATH", path)
        .env_remove("SPADE_SIGN_IDENTITY")
        .output()?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Ok((
        out.status.success(),
        text,
        std::fs::read_to_string(&signed).ok(),
    ))
}

#[test]
fn an_apple_development_identity_is_preferred() -> Result {
    let (ok, text, signed) = run(concat!(
        "  1) AAAA \"Developer ID Application: Someone (TEAM)\"\n",
        "  2) BBBB \"Apple Development: Someone (DEV)\"\n",
        "     2 valid identities found\n",
    ))?;
    assert!(ok, "{text}");
    assert_eq!(signed.as_deref(), Some("Apple Development: Someone (DEV)"));
    Ok(())
}

#[test]
fn without_apple_development_the_self_signed_identity_is_used() -> Result {
    let (ok, text, signed) = run(concat!(
        "  1) AAAA \"Developer ID Application: Someone (TEAM)\"\n",
        "  2) CCCC \"Spade Local Dev\"\n",
    ))?;
    assert!(ok, "{text}");
    assert_eq!(signed.as_deref(), Some("Spade Local Dev"));
    Ok(())
}

#[test]
fn with_no_stable_identity_it_says_so_and_never_picks_the_developer_id() -> Result {
    let (ok, text, signed) = run("  1) AAAA \"Developer ID Application: Someone (TEAM)\"\n")?;
    assert!(!ok);
    assert!(text.contains("no stable signing identity"), "{text}");
    assert_eq!(signed, None);
    Ok(())
}
