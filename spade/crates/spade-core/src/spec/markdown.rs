//! Writing the spec's regions: the marks a committed file holds them between, and the small
//! Markdown pieces the parts are written in.

use super::Part;

fn begin(name: &str) -> String {
    format!("<!-- spec:begin {name} -->\n")
}

fn end(name: &str) -> String {
    format!("<!-- spec:end {name} -->")
}

/// `text` with each region's body written between its marks. Refused, with every problem, when
/// a region the data writes has no marks in the file (so a table can't silently vanish), or the
/// file holds marks for a region the data no longer writes.
pub fn fill(text: &str, regions: &[(&str, String)]) -> Result<String, Vec<String>> {
    let mut problems = Vec::new();
    let mut out = text.to_owned();
    for (name, body) in regions {
        let (begin, end) = (begin(name), end(name));
        let Some(start) = out.find(&begin).map(|at| at + begin.len()) else {
            problems.push(format!(
                "has no {name} region: add `{}` and `{end}`",
                begin.trim()
            ));
            continue;
        };
        let Some(stop) = out[start..].find(&end).map(|at| start + at) else {
            problems.push(format!("its {name} region has no `{end}`"));
            continue;
        };
        let mut body = body.clone();
        if !body.ends_with('\n') {
            body.push('\n');
        }
        out.replace_range(start..stop, &body);
    }
    for (at, _) in out.match_indices("<!-- spec:begin ") {
        let name = out[at + 16..].split(' ').next().unwrap_or_default();
        if !regions.iter().any(|(known, _)| *known == name) {
            problems.push(format!("holds a {name} region the data doesn't write"));
        }
    }
    if problems.is_empty() {
        Ok(out)
    } else {
        Err(problems)
    }
}

/// A part's title, version and license, the same in every part.
pub fn header(part: &Part) -> String {
    format!(
        "# Spade Agent Format {version}: {title}\n\n\
         <!-- SPDX-License-Identifier: CC-BY-4.0 -->\n\
         <!-- Text between spec:begin and spec:end marks is written from Spade's data (ADR 0201 §4). \
         Don't edit it by hand: change the data and run \
         `SPADE_WRITE_SPEC=1 cargo test -p spade-core spec_doc`. -->\n\n\
         Part `{id}`, version {part_version}, of the [Spade Agent Format](README.md) \
         {version}. {fixes}\n\n\
         This text is licensed under \
         [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the schemas and the \
         conformance suite under Apache-2.0 ([LICENSE.md](LICENSE.md)). The key words MUST, \
         MUST NOT, SHOULD and MAY are to be read as RFC 2119 and RFC 8174 define them, when in \
         capitals.\n",
        version = super::VERSION,
        title = part.title,
        id = part.id,
        part_version = part.version,
        fixes = part.fixes,
    )
}

/// A table with a header row.
pub fn table(head: &[&str], rows: impl IntoIterator<Item = Vec<String>>) -> String {
    let mut out = format!("| {} |\n|", head.join(" | "));
    out.push_str(&" --- |".repeat(head.len()));
    out.push('\n');
    for row in rows {
        out.push_str(&format!("| {} |\n", row.join(" | ")));
    }
    out
}

/// Words as code, joined with commas.
pub fn code_list<'a>(words: impl IntoIterator<Item = &'a str>) -> String {
    words
        .into_iter()
        .map(|word| format!("`{word}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// A bound as the spec writes it: `16 KiB`, `65,536`.
pub fn bytes(n: usize) -> String {
    if n >= 1024 * 1024 && n.is_multiple_of(1024 * 1024) {
        format!("{} MiB", n / (1024 * 1024))
    } else if n >= 1024 && n.is_multiple_of(1024) {
        format!("{} KiB", n / 1024)
    } else {
        format!("{} bytes", number(n as u64))
    }
}

/// A whole number with thousands marked.
pub fn number(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// A suite's cases as a table: each id, what it is, and what a reader MUST answer.
pub fn cases(suite: &super::conformance::Suite) -> String {
    let rows = suite.cases().into_iter().map(|case| {
        let expected = match case["rule"].as_str() {
            Some(rule) => format!("refuse by `{rule}`"),
            None => "accept".to_owned(),
        };
        let name = case["name"].as_str().unwrap_or_default();
        let id = case["id"].as_str().unwrap_or_default();
        vec![format!("`{id}`"), cell(name), expected]
    });
    let file = format!("conformance/{}", suite.file);
    format!(
        "From [`{file}`]({file}).\n\n{}",
        table(&["Case", "What it is", "A reader MUST"], rows)
    )
}

/// A level's cases as a table: each id and what a runtime MUST do.
pub fn level_cases(suites: &[&super::conformance::Suite]) -> String {
    let mut out = String::new();
    for suite in suites {
        let rows = suite.cases().into_iter().map(|case| {
            let name = case["name"].as_str().unwrap_or_default();
            let id = case["id"].as_str().unwrap_or_default();
            vec![format!("`{id}`"), cell(name)]
        });
        let file = format!("conformance/{}", suite.file);
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&format!(
            "From [`{file}`]({file}).\n\n{}",
            table(&["Case", "A runtime MUST pass"], rows)
        ));
    }
    out
}

/// A part's rules as a table: each id, what it refuses, and whether the part's JSON Schema alone
/// decides it.
pub fn rules(part: &str) -> String {
    let rows = crate::rule::RULES
        .iter()
        .filter(|rule| rule.part == part)
        .map(|rule| {
            let schema = if rule.schema { "yes" } else { "no" };
            vec![format!("`{}`", rule.id), cell(rule.says), schema.to_owned()]
        });
    format!(
        "From [`conformance/rules.json`](conformance/rules.json).\n\n{}",
        table(
            &["Rule", "A reader MUST refuse", "The JSON Schema decides it"],
            rows
        )
    )
}

/// Text that sits in a table cell: no pipe ends it early.
pub fn cell(text: &str) -> String {
    text.replace('|', "\\|")
}
