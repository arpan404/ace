//! The Reader level: every manifest case and every schema case of the suite, fed to a reader
//! through its door. A refusal matches a case only by the rule it names.
//!
//! The door answers JSON on stdout:
//!
//! - `<cmd> read <folder>`: `{accepted, problems: [{rule, message}]}` for the package there.
//! - `<cmd> fit <file>`, the file `{schema, at, values}`: `{accepted, problems, values: [{fits,
//!   misfits: [at]}]}`, the schema read and each value checked against it.

use std::ffi::OsString;
use std::path::Path;

use serde_json::{Value, json};

use crate::folder;
use crate::report::{Level, Outcome};
use crate::suite::{self, File};

/// A reader, behind its door.
pub trait ReaderDoor {
    /// The answer for the package folder at `folder`.
    fn read(&self, folder: &Path) -> impl Future<Output = Result<Value, String>>;
    /// The answer for the schema question in the file at `file`.
    fn fit(&self, file: &Path) -> impl Future<Output = Result<Value, String>>;
}

/// A reader that is a command: `program args… read <folder>`, `program args… fit <file>`.
pub struct Command {
    pub program: OsString,
    pub args: Vec<OsString>,
}

impl Command {
    async fn answer(&self, verb: &str, path: &Path) -> Result<Value, String> {
        let ran = tokio::process::Command::new(&self.program)
            .args(&self.args)
            .arg(verb)
            .arg(path)
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|e| format!("the reader didn't start: {e}"))?;
        serde_json::from_slice(&ran.stdout).map_err(|e| {
            format!(
                "the reader's answer isn't JSON ({e}); it said: {}",
                String::from_utf8_lossy(&ran.stderr).trim()
            )
        })
    }
}

impl ReaderDoor for Command {
    async fn read(&self, folder: &Path) -> Result<Value, String> {
        self.answer("read", folder).await
    }

    async fn fit(&self, file: &Path) -> Result<Value, String> {
        self.answer("fit", file).await
    }
}

/// The rules an answer's problems name.
fn rules(answer: &Value) -> Vec<String> {
    answer["problems"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p["rule"].as_str().map(str::to_owned))
        .collect()
}

fn accepted(answer: &Value) -> Result<bool, String> {
    answer["accepted"]
        .as_bool()
        .ok_or_else(|| format!("the answer says nothing of accepted: {answer}"))
}

/// Whether `answer` is what `case` expects of a reader: accepted, or refused by its rule.
fn judged(case: &Value, answer: &Value) -> Result<(), String> {
    let accepted = accepted(answer)?;
    match case["rule"].as_str() {
        None if accepted => Ok(()),
        None => Err(format!(
            "refused what a reader MUST accept: {}",
            answer["problems"]
        )),
        Some(rule) if accepted => Err(format!("accepted what a reader MUST refuse by {rule}")),
        Some(rule) => {
            let named = rules(answer);
            if named.iter().any(|r| r == rule) {
                Ok(())
            } else {
                Err(format!("refused, but by {named:?}, never by {rule}"))
            }
        }
    }
}

async fn manifest_case(door: &impl ReaderDoor, file: &Value, case: &Value) -> Result<(), String> {
    let bot = suite::merged(&file["base"], &case["with"]);
    let package = folder::package(&bot, &folder::files(&case["files"]))?;
    let answer = door.read(package.path()).await?;
    judged(case, &answer)
}

async fn schema_case(door: &impl ReaderDoor, case: &Value) -> Result<(), String> {
    let fits: Vec<Value> = case["fits"].as_array().cloned().unwrap_or_default();
    let misfits: Vec<Value> = case["misfits"].as_array().cloned().unwrap_or_default();
    let values: Vec<Value> = fits
        .iter()
        .cloned()
        .chain(misfits.iter().map(|m| m["value"].clone()))
        .collect();
    let asked = json!({ "schema": case["schema"], "at": "input", "values": values });
    let dir = tempfile::tempdir().map_err(|e| format!("no temporary folder: {e}"))?;
    let path = dir.path().join("schema.json");
    std::fs::write(&path, asked.to_string()).map_err(|e| e.to_string())?;
    let answer = door.fit(&path).await?;
    judged(case, &answer)?;
    if case["rule"].is_string() {
        return Ok(());
    }
    let answered = answer["values"].as_array().cloned().unwrap_or_default();
    if answered.len() != values.len() {
        return Err(format!(
            "it answered {} values of {}",
            answered.len(),
            values.len()
        ));
    }
    for (value, said) in fits.iter().zip(&answered) {
        if said["fits"] != true {
            return Err(format!("{value} fits, but it said {}", said["misfits"]));
        }
    }
    for (miss, said) in misfits.iter().zip(&answered[fits.len()..]) {
        let at = miss["at"].as_str().unwrap_or_default();
        let places = said["misfits"].as_array().cloned().unwrap_or_default();
        if !places.iter().any(|p| p == at) {
            return Err(format!(
                "{} misses at {at}, but it said {places:?}",
                miss["value"]
            ));
        }
    }
    Ok(())
}

/// Every Reader case, through `door`.
pub async fn run(door: &impl ReaderDoor) -> Level {
    let mut cases = Vec::new();
    for file in &suite::MANIFESTS {
        cases.extend(manifests(door, file).await);
    }
    for case in suite::SCHEMAS.cases() {
        cases.push(Outcome::of(
            suite::id(&case),
            schema_case(door, &case).await,
        ));
    }
    Level {
        level: "Reader",
        cases,
    }
}

async fn manifests(door: &impl ReaderDoor, file: &File) -> Vec<Outcome> {
    let all = file.json();
    let mut out = Vec::new();
    for case in file.cases() {
        out.push(Outcome::of(
            suite::id(&case),
            manifest_case(door, &all, &case).await,
        ));
    }
    out
}
