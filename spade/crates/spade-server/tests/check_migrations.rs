//! `spade-server --check-migrations` as an updater runs it: the real binary against a copy of a
//! database.

use std::process::Command;

use spade_core::Event;
use spade_store::Store;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

fn check(path: &std::path::Path) -> Result<(Option<i32>, String)> {
    let output = Command::new(env!("CARGO_BIN_EXE_spade-server"))
        .arg("--check-migrations")
        .arg(path)
        // Proves the check never reads the data folder: it would be created here if it did.
        .env("SPADE_DATA_DIR", path.with_extension("data"))
        .output()?;
    Ok((
        output.status.code(),
        String::from_utf8_lossy(&output.stderr).trim().to_owned(),
    ))
}

#[test]
fn the_check_accepts_a_good_copy_and_rejects_a_corrupted_one_with_a_reason() -> Result {
    let dir = tempfile::tempdir()?;
    let live = dir.path().join("spade.sqlite");
    {
        let store = Store::open(&live)?;
        store.create_conversation("c_1", 1)?;
        store.append("c_1", &Event::user_message("Hello"), 2)?;
    }
    let copy = dir.path().join("snapshot.sqlite");
    std::fs::copy(&live, &copy)?;
    assert_eq!(check(&copy)?, (Some(0), String::new()));
    assert!(!copy.with_extension("data").exists());

    let mut bytes = std::fs::read(&copy)?;
    // Overwrite everything after the header: the schema and pages are gone.
    for byte in bytes.iter_mut().skip(100) {
        *byte = 0xa5;
    }
    let corrupted = dir.path().join("corrupted.sqlite");
    std::fs::write(&corrupted, &bytes)?;
    let (code, why) = check(&corrupted)?;
    assert_eq!(code, Some(1));
    assert!(!why.is_empty() && !why.contains('\n'), "{why:?}");
    Ok(())
}
