// SPDX-License-Identifier: Apache-2.0
//! Strict `git ls-files --stage -z` and `git ls-tree -z` parsing
//! (`packages/git/src/parse-index.ts`, G3b), and the temporary-index helpers that use them
//! (`temporary-index.ts`'s `removeIndexSubtrees` and `statusWithoutHidingFlags`, moved here once
//! this parser existed).
//!
//! Proof: `malformed-output.test.ts`'s index and tree cases (moved here), and
//! `repository.process`'s temporary-index cases, which leave the person's index unchanged.

use crate::core::decode::{MODE_SCHEMA, hash, malformed, nul, path_schema};
use crate::core::error::GitError;
use crate::core::temp_index::TemporaryIndex;
use crate::reads::status::state;
use crate::reads::{Command, CommandOutput, CommandPort, checked};

/// One index record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexEntry {
    pub mode: String,
    pub sha: String,
    pub stage: String,
    pub path: String,
}

/// One tree record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeEntry {
    pub mode: String,
    pub kind: String,
    pub sha: String,
    pub path: String,
}

fn mode_schema(value: &str) -> bool {
    MODE_SCHEMA.contains(&value)
}

fn index_mode(value: &str) -> bool {
    mode_schema(value) && value != "000000"
}

fn tree_kind(mode: &str, kind: &str) -> bool {
    let expected = match mode {
        "040000" => "tree",
        "160000" => "commit",
        _ => "blob",
    };
    expected == kind && mode != "000000"
}

/// Parses `ls-files --stage -z`.
pub fn parse_index(bytes: &[u8]) -> Result<Vec<IndexEntry>, GitError> {
    let mut entries = Vec::new();
    for record in nul(bytes)? {
        let Some(tab) = record.find('\t') else {
            return Err(malformed("index record"));
        };
        let fields: Vec<&str> = record[..tab].split(' ').collect();
        let [mode, sha, stage] = match fields.as_slice() {
            [mode, sha, stage] => [*mode, *sha, *stage],
            _ => return Err(malformed("index record")),
        };
        if !index_mode(mode) || !matches!(stage, "0" | "1" | "2" | "3") {
            return Err(malformed("index record"));
        }
        hash(sha)?;
        let path = path_schema(&record[tab + 1..]).ok_or_else(|| malformed("index path"))?;
        entries.push(IndexEntry {
            mode: mode.to_owned(),
            sha: sha.to_owned(),
            stage: stage.to_owned(),
            path,
        });
    }
    Ok(entries)
}

/// Parses `ls-tree -z`.
pub fn parse_tree(bytes: &[u8]) -> Result<Vec<TreeEntry>, GitError> {
    let mut entries = Vec::new();
    for record in nul(bytes)? {
        let Some(tab) = record.find('\t') else {
            return Err(malformed("tree record"));
        };
        let fields: Vec<&str> = record[..tab].split(' ').collect();
        let [mode, kind, sha] = match fields.as_slice() {
            [mode, kind, sha] => [*mode, *kind, *sha],
            _ => return Err(malformed("tree record")),
        };
        if !mode_schema(mode)
            || !matches!(kind, "blob" | "tree" | "commit")
            || !tree_kind(mode, kind)
        {
            return Err(malformed("tree mode/type"));
        }
        hash(sha)?;
        let path = path_schema(&record[tab + 1..]).ok_or_else(|| malformed("tree path"))?;
        entries.push(TreeEntry {
            mode: mode.to_owned(),
            kind: kind.to_owned(),
            sha: sha.to_owned(),
            path,
        });
    }
    Ok(entries)
}

/// The subset of bash arrays the temporary index cannot see: a path under any of `paths`
/// (`temporary-index.ts`'s `removeIndexSubtrees`).
pub async fn remove_index_subtrees(
    port: &dyn CommandPort,
    root: &str,
    paths: &[String],
    env: &[(&str, &str)],
) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }
    let output: CommandOutput = checked(
        port,
        Command::new(root, &["ls-files", "--stage", "-z"]).with_env(env),
    )
    .await?;
    let entries = parse_index(&output.stdout)?;
    let remove: Vec<&IndexEntry> = entries
        .iter()
        .filter(|entry| {
            crate::core::decode::path_ancestors(&entry.path)
                .iter()
                .any(|ancestor| paths.iter().any(|root| root == ancestor))
        })
        .collect();
    if remove.is_empty() {
        return Ok(());
    }
    let mut input = String::new();
    for entry in remove {
        input.push_str(&entry.path);
        input.push('\0');
    }
    checked(
        port,
        Command::new(root, &["update-index", "--force-remove", "-z", "--stdin"])
            .with_env(env)
            .with_input(input.as_bytes())
            .writing(),
    )
    .await?;
    Ok(())
}

/// The status a temporary index reports, seeded with the person's entries but not their
/// `assume-unchanged` or skip-worktree flags (`temporary-index.ts`'s `statusWithoutHidingFlags`).
pub async fn status_without_hiding_flags(
    port: &dyn CommandPort,
    root: &str,
    temp_directory: &str,
) -> Result<crate::parse::status::Status, GitError> {
    let output = checked(port, Command::new(root, &["ls-files", "--stage", "-z"])).await?;
    let entries = parse_index(&output.stdout)?;
    let index = TemporaryIndex::create(temp_directory)?;
    let env: Vec<(&str, &str)> = index
        .env()
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    checked(
        port,
        Command::new(root, &["read-tree", "--empty"])
            .with_env(&env)
            .writing(),
    )
    .await?;
    let mut seed = String::new();
    for entry in &entries {
        seed.push_str(&format!(
            "{} {} {}\t{}\0",
            entry.mode, entry.sha, entry.stage, entry.path
        ));
    }
    checked(
        port,
        Command::new(root, &["update-index", "-z", "--index-info"])
            .with_env(&env)
            .with_input(seed.as_bytes())
            .writing(),
    )
    .await?;
    Ok(state(port, root, &env).await?.status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::core::error::GitErrorCode;
    use crate::reads::test_support::ProcessCommands;

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    // Every case of `malformed-output.test.ts`'s index and tree tables.
    #[test]
    fn malformed_index_and_tree_records_are_refused_with_a_typed_error() {
        for output in [
            "100644 abc\tfile\0".to_owned(),
            format!("100644 {SHA} 9\tfile\0"),
            format!("100644 {SHA} 0\t../file\0"),
        ] {
            let error = parse_index(output.as_bytes()).expect_err(&output);
            assert_eq!(error.code, GitErrorCode::MalformedOutput, "{output:?}");
        }
        for output in [
            format!("100644 {SHA}\tfile\0"),
            format!("100644 other {SHA}\tfile\0"),
            format!("100644 tree {SHA}\tfile\0"),
            format!("100644 blob {SHA}\t../file\0"),
        ] {
            let error = parse_tree(output.as_bytes()).expect_err(&output);
            assert_eq!(error.code, GitErrorCode::MalformedOutput, "{output:?}");
        }
    }

    #[test]
    fn index_and_tree_records_read_their_fields() {
        assert_eq!(
            parse_index(format!("100755 {SHA} 2\tpath with tab\tname\0").as_bytes())
                .expect("index"),
            vec![IndexEntry {
                mode: "100755".to_owned(),
                sha: SHA.to_owned(),
                stage: "2".to_owned(),
                path: "path with tab\tname".to_owned(),
            }]
        );
        assert_eq!(
            parse_tree(format!("040000 tree {SHA}\tdir\0").as_bytes()).expect("tree"),
            vec![TreeEntry {
                mode: "040000".to_owned(),
                kind: "tree".to_owned(),
                sha: SHA.to_owned(),
                path: "dir".to_owned(),
            }]
        );
        let error = parse_tree(format!("100644 blob {SHA}\tfile\0").as_bytes())
            .err()
            .map(|error| error.code);
        assert_eq!(error, None);
    }

    // `repository.process`: temporary-index helpers leave the person's index untouched.
    #[tokio::test]
    async fn a_temporary_status_ignores_assume_unchanged_and_removing_subtrees_keeps_the_rest() {
        let fixture = Fixture::new("g3b-temp-index");
        let repo = fixture.repository("repo");
        std::fs::create_dir_all(repo.join("dir/sub")).expect("dirs");
        std::fs::write(repo.join("dir/sub/file.txt"), "one\n").expect("file");
        std::fs::write(repo.join("keep.txt"), "keep\n").expect("keep");
        fixture.git(&repo, &["add", "."]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "tree"]);
        fixture.git(&repo, &["update-index", "--assume-unchanged", "keep.txt"]);
        std::fs::write(repo.join("keep.txt"), "changed\n").expect("edit");
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy().into_owned();
        // The person's own status hides the assumed-unchanged edit...
        let hidden = state(&port, &root, &[]).await.expect("status");
        assert!(hidden.status.unstaged.is_empty());
        // ...the temporary index does not.
        let fresh = status_without_hiding_flags(&port, &root, &fixture.root.to_string_lossy())
            .await
            .expect("temporary status");
        assert_eq!(fresh.unstaged.len(), 1);
        assert_eq!(fresh.unstaged[0].path, "keep.txt");

        // Removing a subtree drops its rows from a temporary index and nothing else.
        let index = TemporaryIndex::create(&fixture.root.to_string_lossy()).expect("index");
        let env: Vec<(&str, &str)> = index
            .env()
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        let seed = String::from_utf8_lossy(&fixture.git(&repo, &["ls-files", "--stage", "-z"]))
            .into_owned();
        checked(
            &port,
            Command::new(&root, &["update-index", "-z", "--index-info"])
                .with_env(&env)
                .with_input(seed.as_bytes())
                .writing(),
        )
        .await
        .expect("seed");
        remove_index_subtrees(&port, &root, &["dir".to_owned()], &env)
            .await
            .expect("remove");
        let remaining = checked(
            &port,
            Command::new(&root, &["ls-files", "-z"]).with_env(&env),
        )
        .await
        .expect("listing");
        assert_eq!(
            String::from_utf8_lossy(&remaining.stdout),
            "file.txt\u{0}keep.txt\u{0}"
        );
        // The person's index still has the subtree.
        let person = fixture.git(&repo, &["ls-files", "-z"]);
        assert!(String::from_utf8_lossy(&person).contains("dir/sub/file.txt"));
    }
}
