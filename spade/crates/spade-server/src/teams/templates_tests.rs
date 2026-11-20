use std::collections::BTreeSet;
use std::path::PathBuf;

use super::*;
use spade_core::routine::Trigger;

fn folder() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../templates")
}

/// Every file under `root`, by its path inside it.
fn files_in(root: &std::path::Path) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(inside) = path.strip_prefix(root) {
                found.insert(inside.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    found
}

#[test]
fn every_template_folder_ships_whole_and_in_the_index() {
    let mut folders: Vec<String> = std::fs::read_dir(folder())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    folders.sort();
    let mut shipped: Vec<String> = packages().iter().map(|p| p.template.id.clone()).collect();
    shipped.sort();
    assert_eq!(
        shipped, folders,
        "each folder is a shipped template, read without problems"
    );
    for package in packages() {
        let on_disk = files_in(&folder().join(&package.template.id));
        let built: BTreeSet<String> = package.files.iter().map(|(p, _)| (*p).to_owned()).collect();
        assert_eq!(
            built, on_disk,
            "{}: every file of its folder is built in",
            package.template.id
        );
        let tests: BTreeSet<String> = package.manifest.tests.iter().cloned().collect();
        let scenarios: BTreeSet<String> = on_disk
            .into_iter()
            .filter(|p| p.starts_with("tests/"))
            .collect();
        assert_eq!(
            tests, scenarios,
            "{}: tests names every scenario it ships",
            package.template.id
        );
    }
}

#[test]
fn every_shipped_template_is_usable() {
    let all = templates();
    assert_eq!(all.len(), 10, "the ten templates of ADR 0132 §11");
    let mut pairs: Vec<_> = all.iter().filter_map(|t| t.face["pair"].as_str()).collect();
    pairs.sort_unstable();
    pairs.dedup();
    assert_eq!(
        pairs.len(),
        all.len(),
        "each template wears its own colours"
    );
    for template in &all {
        let face = spade_core::face::repair(&template.face);
        assert!(spade_core::face::is_valid(&face));
        assert_eq!(
            face.to_json(),
            template.face,
            "{}: the face as drawn",
            template.id
        );
        assert!(matches!(template.model_kind.as_str(), "fast" | "capable"));
        for routine in &template.routines {
            assert!(
                !routine.words.is_empty(),
                "{}: its schedule in words",
                template.id
            );
            let trigger = Trigger::Schedule {
                schedule: routine.schedule.clone(),
            };
            assert!(
                trigger.schedule().is_ok_and(|s| s.is_some()),
                "{}: {:?} doesn't read",
                template.id,
                routine.schedule
            );
        }
    }
}

#[test]
fn a_template_is_a_version_3_package_linked_to_spade_by_its_content() {
    for package in packages() {
        assert_eq!(package.manifest.version, 3, "{}", package.template.id);
        assert_eq!(package.package.source, SOURCE);
        assert_eq!(package.package.name, package.template.id);
        assert_eq!(package.package.hash, content_hash(&package.files));
    }
    // The market's own hash of the same files (`contentHash(hashFiles(…))` in @ace/marketplace),
    // so a template's link names its bytes as `ace bot check` and the market do.
    assert_eq!(
        content_hash(&[("bot.json", "{\"name\":\"Ä\"}\n"), ("README.md", "# A\n")]),
        "f52eb44244f768ab15e082a02f9d9d49e2444298b09ff86db047d497dcb8f69b"
    );
    // The hash changes with any byte, so a corrected template reads as a new version's bytes.
    let files = [("bot.json", "{}"), ("README.md", "# A")];
    let changed = [("bot.json", "{}"), ("README.md", "# B")];
    assert_ne!(content_hash(&files), content_hash(&changed));
    // And it doesn't depend on the order the files are listed in.
    let reversed = [("README.md", "# A"), ("bot.json", "{}")];
    assert_eq!(content_hash(&files), content_hash(&reversed));
}

#[tokio::test]
async fn every_template_passes_its_own_scenarios() -> Result<(), Box<dyn std::error::Error>> {
    for package in packages() {
        let dir = tempfile::tempdir()?;
        for (path, text) in &package.files {
            let file = dir.path().join(path);
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&file, text)?;
        }
        let report = crate::bot_test::run(dir.path()).await;
        assert!(
            report.passed(),
            "{}: {:?} {:?}",
            package.template.id,
            report.problems,
            report.scenarios
        );
        assert_eq!(report.scenarios.len(), package.manifest.tests.len());
    }
    Ok(())
}
