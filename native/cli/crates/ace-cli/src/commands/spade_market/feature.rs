// SPDX-License-Identifier: Apache-2.0
//! `ace feature list`: the Beta switches from the home's files, without a daemon.

use std::io::Write;
use std::path::Path;

use cli_out::{Out, Outcome, OutputMode};
use cli_parse::Parsed;

use super::common;
use crate::run::fail;

/// The switches on Settings › Beta, read from the home without writing anything.
#[derive(Clone, Copy)]
struct Features {
    spade: bool,
    marketplace: bool,
}

pub fn run<W: Write, E: Write>(parsed: &Parsed<'_>, out: &mut Out<W>, err: &mut Out<E>) -> Outcome {
    let output = crate::commands::work::common::mode(parsed);
    match read_features() {
        Ok(features) => render(features, output, out, err),
        Err(failure) => fail(
            out,
            err,
            Some(&parsed.flags),
            &failure.with_command(parsed.command.id),
        ),
    }
}

/// A boolean the global `settings.json` holds, read without a settings service.
pub(crate) fn boolean_at_rest(home: &Path, key: &str) -> Option<bool> {
    let path = home.join("settings.json");
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > 1024 * 1024 {
        return None;
    }
    let text = std::fs::read_to_string(&path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&text).ok()?;
    if let Some(on) = parsed
        .get("settings")
        .and_then(|settings| settings.get(key))
        .and_then(serde_json::Value::as_bool)
    {
        return Some(on);
    }
    // A version 1 home, read as the settings service migrates it.
    if parsed.get("version").and_then(serde_json::Value::as_u64) == Some(1) {
        return parsed
            .get("values")
            .and_then(|values| values.get(key))
            .and_then(serde_json::Value::as_bool);
    }
    None
}

/// The old file that showed Spade with `{"spade": true}`, folded in once a setting exists.
pub(crate) fn legacy_spade(home: &Path) -> bool {
    let text = std::fs::read_to_string(home.join("features.json")).unwrap_or_default();
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|parsed| parsed.get("spade")?.as_bool())
        .unwrap_or(false)
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn read_features() -> Result<Features, cli_out::Failure<'static>> {
    let home = cli_wire::Home::from_env()
        .map_err(|err| crate::commands::work::common::wire_failure(&err, Some("feature.list")))?;
    let spade = match boolean_at_rest(home.path(), "beta.spade") {
        Some(on) => on,
        None => legacy_spade(home.path()),
    };
    let marketplace = boolean_at_rest(home.path(), "beta.marketplace").unwrap_or(false);
    Ok(Features { spade, marketplace })
}

fn render<W: Write, E: Write>(
    features: Features,
    output: OutputMode,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let on_off = |on: bool| if on { "on" } else { "off" };
    match output {
        OutputMode::Json => {
            let value = serde_json::json!({
                "spade": features.spade,
                "marketplace": features.marketplace,
            });
            match out.json(&value) {
                Ok(()) => Outcome::Ok,
                Err(error) => common::write_failed("feature.list", &error, out, err),
            }
        }
        OutputMode::Human => {
            let lines = [
                format!("Spade: {}", on_off(features.spade)),
                format!("Store: {}", on_off(features.marketplace)),
            ];
            match lines.iter().try_for_each(|line| out.line(line)) {
                Ok(()) => Outcome::Ok,
                Err(error) => common::write_failed("feature.list", &error, out, err),
            }
        }
        OutputMode::Quiet => {
            let mut names = Vec::new();
            if features.spade {
                names.push("spade".to_owned());
            }
            if features.marketplace {
                names.push("marketplace".to_owned());
            }
            match names.iter().try_for_each(|name| out.line(name)) {
                Ok(()) => Outcome::Ok,
                Err(error) => common::write_failed("feature.list", &error, out, err),
            }
        }
    }
}
