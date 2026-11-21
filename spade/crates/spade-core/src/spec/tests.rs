use super::*;

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec");

/// Every committed spec file is what the data writes; `SPADE_WRITE_SPEC=1` writes them.
#[test]
fn spec_doc_files_are_written_from_the_data() {
    let files = files().unwrap_or_else(|problems| panic!("{}", problems.join("\n")));
    let write = std::env::var_os("SPADE_WRITE_SPEC").is_some();
    let mut stale = Vec::new();
    for file in files {
        let path = format!("{ROOT}/{}", file.path);
        let committed = std::fs::read_to_string(&path).unwrap_or_default();
        let written = fill(&committed, &file.regions)
            .unwrap_or_else(|problems| panic!("spade/spec/{}: {}", file.path, problems.join("; ")));
        if write {
            std::fs::write(&path, &written).unwrap_or_else(|e| panic!("{path}: {e}"));
        } else if written != committed {
            stale.push(file.path);
        }
    }
    assert!(
        stale.is_empty(),
        "spade/spec/{} isn't what the data writes; run \
         SPADE_WRITE_SPEC=1 cargo test -p spade-core spec_doc",
        stale.join(", spade/spec/")
    );
}

/// Every file the data writes whole (the rule table, the JSON Schemas) is what it writes.
#[test]
fn spec_doc_whole_files_are_written_from_the_data() {
    let write = std::env::var_os("SPADE_WRITE_SPEC").is_some();
    let mut stale = Vec::new();
    for file in wholes() {
        let path = format!("{ROOT}/{}", file.path);
        if write {
            if let Some(folder) = std::path::Path::new(&path).parent() {
                std::fs::create_dir_all(folder).unwrap_or_else(|e| panic!("{path}: {e}"));
            }
            std::fs::write(&path, &file.text).unwrap_or_else(|e| panic!("{path}: {e}"));
        } else if std::fs::read_to_string(&path).ok().as_deref() != Some(file.text.as_str()) {
            stale.push(file.path);
        }
    }
    assert!(
        stale.is_empty(),
        "spade/spec/{} isn't what the data writes; run \
         SPADE_WRITE_SPEC=1 cargo test -p spade-core spec_doc",
        stale.join(", spade/spec/")
    );
}

/// Every refusal of the suite names a rule of the table, and the table's ids are unique.
#[test]
fn every_case_names_a_rule_of_the_table() {
    let mut ids: Vec<&str> = crate::rule::RULES.iter().map(|r| r.id).collect();
    ids.sort_unstable();
    let before = ids.len();
    ids.dedup();
    assert_eq!(ids.len(), before, "each rule id once");
    let suites = conformance::MANIFESTS
        .iter()
        .chain(std::iter::once(&conformance::SCHEMAS));
    for suite in suites {
        for case in suite.cases() {
            if let Some(rule) = case["rule"].as_str() {
                assert!(
                    crate::rule::of(rule).is_some(),
                    "{}: no rule {rule}",
                    case["id"]
                );
            }
        }
    }
}

#[test]
fn a_region_is_written_between_its_marks_and_the_prose_around_it_is_kept() {
    let text = "Prose.\n<!-- spec:begin words -->\nold\n<!-- spec:end words -->\nMore prose.\n";
    let written = fill(text, &[("words", "`read`, `pay`".to_owned())]);
    assert_eq!(
        written,
        Ok(
            "Prose.\n<!-- spec:begin words -->\n`read`, `pay`\n<!-- spec:end words -->\nMore prose.\n"
                .to_owned()
        )
    );
}

#[test]
fn a_spec_file_that_lost_a_tables_marks_or_kept_a_stale_one_is_refused() {
    let lost = fill("Prose only.\n", &[("words", "x".to_owned())]);
    assert!(lost.is_err_and(|p| p[0].contains("has no words region")));
    let unended = fill("<!-- spec:begin words -->\n", &[("words", "x".to_owned())]);
    assert!(unended.is_err_and(|p| p[0].contains("no `<!-- spec:end words -->`")));
    let stale = fill("<!-- spec:begin gone -->\nx\n<!-- spec:end gone -->\n", &[]);
    assert!(stale.is_err_and(|p| p[0].contains("gone region the data doesn't write")));
}
