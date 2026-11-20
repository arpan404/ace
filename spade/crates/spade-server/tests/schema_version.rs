//! `spade --schema-version` as a release runs it: the real binary says the schema version a
//! database it opens is brought up to, which the release publishes in `ace-data.json`.

use std::process::Command;

use spade_store::Store;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

#[test]
fn the_binary_reports_the_schema_its_store_migrates_a_new_database_to() -> Result {
    let output = Command::new(env!("CARGO_BIN_EXE_spade"))
        .arg("--schema-version")
        .output()?;
    assert!(output.status.success());
    let reported: i64 = String::from_utf8(output.stdout)?.trim().parse()?;

    let dir = tempfile::tempdir()?;
    let path = dir.path().join("spade.sqlite");
    drop(Store::open(&path)?);
    let connection = spade_store::Store::connect(&path)?;
    let stored: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    assert_eq!(reported, stored);
    assert!(reported > 0);
    Ok(())
}
