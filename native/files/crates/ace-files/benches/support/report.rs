// SPDX-License-Identifier: Apache-2.0

//! The bench's output: a table for the person reading the run, and the same numbers as JSON.

use std::fmt::Write as _;
use std::fs;
use std::path::Path;

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
    facts: Vec<(String, String)>,
    metrics: Vec<Metric>,
}

impl Report {
    /// A report for a run with this title.
    pub fn new(title: impl Into<String>) -> Report {
        Report {
            title: title.into(),
            facts: Vec::new(),
            metrics: Vec::new(),
        }
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

    /// Print the table the person reads.
    pub fn print(&self) {
        println!();
        println!("{}", self.title);
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

    /// Write the same numbers as JSON.
    pub fn write_json(&self, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
        let mut json = String::new();
        json.push_str("{\n");
        let _ = writeln!(json, "  \"title\": {},", quote(&self.title));
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
        fs::write(path, json)?;
        Ok(())
    }
}

/// A value with the precision its unit deserves.
fn format_value(value: f64, unit: &str) -> String {
    match unit {
        "ms" | "MB" | "s" | "MB/s" => format!("{value:.1} {unit}"),
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
