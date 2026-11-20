// SPDX-License-Identifier: Apache-2.0

//! The bench's output: a table for the person reading the run, and the same numbers as JSON.
//!
//! A run that fails part way still publishes what it measured: the status says `partial` when
//! some numbers were recorded and `failed` when none were, and the JSON is written to a temporary
//! file and renamed so a reader never sees half of it.

use std::fmt::Write as _;
use std::fs;
use std::path::Path;

/// How a run ended.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// Every measurement ran.
    Ok,
    /// Some measurements ran before the failure.
    Partial,
    /// Nothing was measured.
    Failed,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::Partial => "partial",
            Status::Failed => "failed",
        }
    }
}

/// One measured number.
struct Metric {
    name: String,
    value: f64,
    unit: &'static str,
    note: String,
}

/// Everything one run measured, plus the facts it was measured under.
pub struct Report {
    title: String,
    status: Status,
    facts: Vec<(String, String)>,
    metrics: Vec<Metric>,
}

impl Report {
    /// A report for a run with this title.
    pub fn new(title: impl Into<String>) -> Report {
        Report {
            title: title.into(),
            status: Status::Ok,
            facts: Vec::new(),
            metrics: Vec::new(),
        }
    }

    /// Rename the run once its tree is known.
    pub fn retitle(&mut self, title: impl Into<String>) {
        self.title = title.into();
    }

    /// One fact about the run, such as the load average.
    pub fn fact(&mut self, name: impl Into<String>, value: impl Into<String>) {
        self.facts.push((name.into(), value.into()));
    }

    /// One measured number.
    pub fn metric(
        &mut self,
        name: impl Into<String>,
        value: f64,
        unit: &'static str,
        note: impl Into<String>,
    ) {
        self.metrics.push(Metric {
            name: name.into(),
            value,
            unit,
            note: note.into(),
        });
    }

    /// Record that the run stopped: `partial` when numbers were measured, `failed` when none were.
    pub fn fail(&mut self, message: impl Into<String>) {
        self.facts.push(("failure".to_owned(), message.into()));
        self.status = if self.metrics.is_empty() {
            Status::Failed
        } else {
            Status::Partial
        };
    }

    /// How the run ended, as the table and JSON print it.
    pub fn status(&self) -> &'static str {
        self.status.as_str()
    }

    /// Print the table the person reads.
    pub fn print(&self) {
        println!();
        println!("{}", self.title);
        println!("  {:<13} {}", "status", self.status.as_str());
        for (name, value) in &self.facts {
            println!("  {name:<13} {value}");
        }
        println!();
        println!("{:<46} {:>12}  note", "metric", "value");
        for metric in &self.metrics {
            println!(
                "{:<46} {:>12}  {}",
                metric.name,
                format_value(metric.value, metric.unit),
                metric.note
            );
        }
        println!();
    }

    /// Write the same numbers as JSON, atomically: a temporary file next to the target, then a
    /// rename, so an interrupted write never leaves a truncated report behind.
    pub fn write_json(&self, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
        let mut json = String::new();
        json.push_str("{\n");
        let _ = writeln!(json, "  \"title\": {},", quote(&self.title));
        let _ = writeln!(json, "  \"status\": {},", quote(self.status.as_str()));
        json.push_str("  \"facts\": {");
        for (position, (name, value)) in self.facts.iter().enumerate() {
            if position > 0 {
                json.push(',');
            }
            let _ = write!(json, "\n    {}: {}", quote(name), quote(value));
        }
        json.push_str("\n  },\n  \"metrics\": [");
        for (position, metric) in self.metrics.iter().enumerate() {
            if position > 0 {
                json.push(',');
            }
            let _ = write!(
                json,
                "\n    {{\"name\": {}, \"value\": {}, \"unit\": {}, \"note\": {}}}",
                quote(&metric.name),
                metric.value,
                quote(metric.unit),
                quote(&metric.note)
            );
        }
        json.push_str("\n  ]\n}\n");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary = path.with_extension("json.tmp");
        fs::write(&temporary, json)?;
        fs::rename(&temporary, path)?;
        Ok(())
    }
}

/// A value with the precision its unit deserves.
fn format_value(value: f64, unit: &str) -> String {
    match unit {
        "ms" | "MB" | "MiB" | "s" | "MB/s" => format!("{value:.1} {unit}"),
        _ => format!("{value:.0} {unit}"),
    }
}

/// A JSON string with the characters JSON needs escaped.
fn quote(text: &str) -> String {
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for character in text.chars() {
        match character {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            character if (character as u32) < 0x20 => {
                let _ = write!(quoted, "\\u{:04x}", character as u32);
            }
            character => quoted.push(character),
        }
    }
    quoted.push('"');
    quoted
}
