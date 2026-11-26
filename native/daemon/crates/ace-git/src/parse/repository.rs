//! Strict `git worktree list --porcelain -z` and `git config -z --get-regexp` parsing
//! (`packages/git/src/parse-repository.ts`, G3a).
//!
//! Proof: `malformed-output.test.ts`'s "worktree list" and "remotes" cases (moved here), and
//! `repository.process`, `worktrees.process`, `checkout-paths.process` and
//! `failure-categories.process`.

use serde::Serialize;

use crate::core::decode::{absolute_path_schema, hash, malformed, nul, ref_schema};
use crate::core::error::GitError;
use crate::core::paths;

/// One registered worktree, as `git worktree list --porcelain` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Worktree {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: Option<String>,
    pub prunable: Option<String>,
}

/// Branch facts a status read reports, in `RepositoryInfo`'s order.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchState {
    pub branch: Option<String>,
    pub detached: bool,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
}

/// A configured remote and the URLs Git holds for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    pub fetch_urls: Vec<String>,
    pub push_urls: Vec<String>,
}

/// A checkout's branch facts and remotes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RepositoryInfo {
    pub root: String,
    #[serde(flatten)]
    pub branch: BranchState,
    pub remotes: Vec<Remote>,
}

/// Parses `worktree list --porcelain -z` bytes.
pub fn parse_worktrees(bytes: &[u8]) -> Result<Vec<Worktree>, GitError> {
    let mut trees: Vec<Worktree> = Vec::new();
    let mut tree: Option<Worktree> = None;
    let mut fields: Vec<String> = Vec::new();
    for record in nul(bytes)? {
        let record = record.as_str();
        if record.is_empty() {
            let finished = tree
                .take()
                .ok_or_else(|| malformed("empty worktree record"))?;
            let detached_and_branch = finished.detached && finished.branch.is_some();
            let bare_with_details = finished.bare
                && (fields.iter().any(|field| field == "HEAD")
                    || finished.branch.is_some()
                    || finished.detached);
            if detached_and_branch || bare_with_details {
                return Err(malformed("contradictory worktree fields"));
            }
            if !finished.bare
                && (!fields.iter().any(|field| field == "HEAD")
                    || (!finished.detached && finished.branch.is_none()))
            {
                return Err(malformed("incomplete worktree record"));
            }
            trees.push(finished);
            fields.clear();
            continue;
        }
        let separator = record.find(' ');
        let key = separator.map_or(record, |index| &record[..index]);
        let value = separator.map_or("", |index| &record[index + 1..]);
        if fields.iter().any(|field| field == key) {
            return Err(malformed("duplicate worktree field"));
        }
        fields.push(key.to_owned());
        if key == "worktree" {
            if tree.is_some() {
                return Err(malformed("worktree separator"));
            }
            tree = Some(Worktree {
                path: absolute_path_schema(value).ok_or_else(|| malformed("worktree path"))?,
                head: None,
                branch: None,
                detached: false,
                bare: false,
                locked: None,
                prunable: None,
            });
            continue;
        }
        let current = tree
            .as_mut()
            .ok_or_else(|| malformed("worktree field order"))?;
        match key {
            "HEAD" => {
                let head = hash(value)?;
                current.head = if head.bytes().all(|byte| byte == b'0') {
                    None
                } else {
                    Some(value.to_owned())
                };
            }
            "branch" => {
                let branch = ref_schema(value).ok_or_else(|| malformed("worktree branch"))?;
                let short = branch
                    .strip_prefix("refs/heads/")
                    .ok_or_else(|| malformed("worktree branch namespace"))?;
                current.branch = Some(short.to_owned());
            }
            "bare" | "detached" => {
                if !value.is_empty() {
                    return Err(malformed(if key == "bare" {
                        "bare flag"
                    } else {
                        "detached flag"
                    }));
                }
                if key == "bare" {
                    current.bare = true;
                } else {
                    current.detached = true;
                }
            }
            "locked" => current.locked = Some(value.to_owned()),
            "prunable" => current.prunable = Some(value.to_owned()),
            _ => return Err(malformed("worktree attribute")),
        }
    }
    if tree.is_some() {
        return Err(malformed("unterminated worktree record"));
    }
    if trees.is_empty() {
        return Err(malformed("missing worktree records"));
    }
    Ok(trees)
}

/// Windows: Git for Windows prints `C:/...`; callers compare native `C:\...` paths.
pub fn native_worktree_paths(trees: &mut [Worktree], is_windows: bool) {
    if !is_windows {
        return;
    }
    for tree in trees {
        tree.path = paths::win32_normalize(&tree.path);
    }
}

/// Parses `git config -z --get-regexp '^remote\..*\.(url|pushurl)$'` bytes.
pub fn parse_remotes(bytes: &[u8]) -> Result<Vec<Remote>, GitError> {
    let mut remotes: Vec<Remote> = Vec::new();
    for record in nul(bytes)? {
        let record = record.as_str();
        let separator = record
            .find('\n')
            .ok_or_else(|| malformed("remote record arity"))?;
        let key = &record[..separator];
        let url = &record[separator + 1..];
        let rest = key
            .strip_prefix("remote.")
            .ok_or_else(|| malformed("remote key"))?;
        let (name, push) = if let Some(name) = rest.strip_suffix(".pushurl") {
            (name, true)
        } else if let Some(name) = rest.strip_suffix(".url") {
            (name, false)
        } else {
            return Err(malformed("remote key"));
        };
        if ref_schema(name).is_none() {
            return Err(malformed("remote key"));
        }
        if url.is_empty() {
            return Err(malformed("remote URL"));
        }
        let index = match remotes.iter().position(|remote| remote.name == name) {
            Some(index) => index,
            None => {
                remotes.push(Remote {
                    name: name.to_owned(),
                    fetch_urls: Vec::new(),
                    push_urls: Vec::new(),
                });
                remotes.len() - 1
            }
        };
        if push {
            remotes[index].push_urls.push(url.to_owned());
        } else {
            remotes[index].fetch_urls.push(url.to_owned());
        }
    }
    for remote in &mut remotes {
        if remote.push_urls.is_empty() {
            remote.push_urls = remote.fetch_urls.clone();
        }
    }
    Ok(remotes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::error::GitErrorCode;

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn rejects(output: &str) {
        let error = parse_worktrees(output.as_bytes()).expect_err(output);
        assert_eq!(error.code, GitErrorCode::MalformedOutput, "{output:?}");
    }

    // Every case of `malformed-output.test.ts`'s "worktree list" table.
    #[test]
    fn malformed_worktree_listings_are_refused_with_a_typed_error() {
        for output in [
            format!("worktree ../outside\0HEAD {SHA}\0branch refs/heads/main\0\0"),
            "worktree /tmp\0HEAD abc\0branch refs/heads/main\0\0".to_owned(),
            "worktree /tmp\0\0".to_owned(),
            "worktree /tmp\0detached extra\0\0".to_owned(),
            format!("worktree /tmp\0HEAD {SHA}\0branch refs/heads/main\0"),
        ] {
            rejects(&output);
        }
    }

    #[test]
    fn a_well_formed_listing_keeps_each_worktrees_fields() {
        let trees = parse_worktrees(
            format!(
                "worktree /main\0HEAD {SHA}\0branch refs/heads/main\0\0worktree /linked\0HEAD {SHA}\0detached\0locked reason\0\0worktree /bare\0bare\0\0"
            )
            .as_bytes(),
        )
        .expect("worktrees");
        assert_eq!(trees.len(), 3);
        assert_eq!(trees[0].branch.as_deref(), Some("main"));
        assert!(trees[1].detached);
        assert_eq!(trees[1].locked.as_deref(), Some("reason"));
        assert!(trees[2].bare);
    }

    #[test]
    fn an_all_zero_head_is_no_head_and_paths_normalise_only_on_windows() {
        let mut trees = parse_worktrees(
            format!("worktree /repos/a\0HEAD {}\0detached\0\0", "0".repeat(40)).as_bytes(),
        )
        .expect("worktrees");
        assert_eq!(trees[0].head, None);
        trees[0].path = "C:/repos/a".to_owned();
        native_worktree_paths(&mut trees, false);
        assert_eq!(trees[0].path, "C:/repos/a");
        native_worktree_paths(&mut trees, true);
        assert_eq!(trees[0].path, "C:\\repos\\a");
    }

    // Every case of `malformed-output.test.ts`'s "remotes" table.
    #[test]
    fn malformed_remote_listings_are_refused_with_a_typed_error() {
        for output in [
            "remote.origin.url\0",
            "remote.origin.other\nurl\0",
            "remote.origin.url\n\0",
        ] {
            let error = parse_remotes(output.as_bytes()).expect_err(output);
            assert_eq!(error.code, GitErrorCode::MalformedOutput, "{output:?}");
        }
    }

    #[test]
    fn remotes_keep_first_seen_order_both_url_kinds_and_copy_fetch_to_push() {
        let remotes = parse_remotes(
            b"remote.origin.url\nhttps://example.invalid/a.git\0remote.upstream.url\nssh://example.invalid/b\0remote.upstream.pushurl\nssh://example.invalid/c\0remote.origin.url\nhttps://example.invalid/d.git\0",
        )
        .expect("remotes");
        assert_eq!(
            remotes,
            vec![
                Remote {
                    name: "origin".to_owned(),
                    fetch_urls: vec![
                        "https://example.invalid/a.git".to_owned(),
                        "https://example.invalid/d.git".to_owned(),
                    ],
                    push_urls: vec![
                        "https://example.invalid/a.git".to_owned(),
                        "https://example.invalid/d.git".to_owned(),
                    ],
                },
                Remote {
                    name: "upstream".to_owned(),
                    fetch_urls: vec!["ssh://example.invalid/b".to_owned()],
                    push_urls: vec!["ssh://example.invalid/c".to_owned()],
                },
            ]
        );
    }
}
