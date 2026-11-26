// SPDX-License-Identifier: Apache-2.0
//! A checkpoint's exact bytes (`packages/git/src/checkpoint-bytes.ts`, G5, Windows): Windows
//! checkouts usually convert line endings (`core.autocrlf=true`), so the tree Git stores for a
//! file is not its bytes. A checkpoint keeps that converted tree for diffs and records the
//! files' own bytes beside it, which a restore writes back with every conversion switched off.
//!
//! These functions are portable; `create_checkpoint` and restore call them only when the
//! platform is Windows, exactly as the TypeScript does.

use crate::checkpoints::metadata::{Checkpoint, checkpoint_prefix};
use crate::checkpoints::numbers::checkpoint_refs;
use crate::core::decode::{hash, malformed};
use crate::core::error::{GitError, GitErrorCode};
use crate::core::objects::ace_commit_env;
use crate::core::temp_index::TemporaryIndex;
use crate::parse::index::parse_tree;
use crate::reads::{Command, CommandPort, checked, text_output};

/// Attributes that leave every path's bytes alone: no eol conversion, filter, ident or encoding.
pub const NEUTRAL_ATTRIBUTES: &str = "* -text -filter -ident -working-tree-encoding\n";

/// `bytesPrefix`: the ref namespace holding one thread's bytes commits, named by checkpoint.
pub fn bytes_prefix(thread_id: &str) -> Result<String, GitError> {
    checkpoint_prefix(thread_id)?;
    Ok(format!("refs/ace/checkpoint-bytes/{thread_id}/"))
}

/// Git's C-style quoting, which `--stdin-paths` undoes, so any path survives one line.
pub fn quoted(path: &str) -> String {
    let mut text = String::from("\"");
    for character in path.chars() {
        let code = character as u32;
        if character == '"' || character == '\\' {
            text.push('\\');
            text.push(character);
        } else if code < 0x20 || code == 0x7f {
            text.push_str(&format!("\\{code:03o}"));
        } else {
            text.push(character);
        }
    }
    text.push('"');
    text
}

/// `bytesTree`: `tree` with every regular file re-hashed from the checkout exactly as it is on
/// disk.
pub async fn bytes_tree(
    port: &dyn CommandPort,
    temp_directory: &str,
    root: &str,
    tree: &str,
) -> Result<String, GitError> {
    let files: Vec<crate::parse::index::TreeEntry> = parse_tree(
        &checked(port, Command::new(root, &["ls-tree", "-r", "-z", tree]))
            .await?
            .stdout,
    )?
    .into_iter()
    .filter(|entry| entry.mode == "100644" || entry.mode == "100755")
    .collect();
    if files.is_empty() {
        return Ok(tree.to_owned());
    }
    // `--no-filters` skips autocrlf, eol, safecrlf and every attribute, including the person's
    // own `info/attributes`, which no command-line setting can override.
    let mut input = String::new();
    for entry in &files {
        input.push_str(&quoted(&entry.path));
        input.push('\n');
    }
    let output = text_output(
        &checked(
            port,
            Command::new(
                root,
                &["hash-object", "-w", "--no-filters", "--stdin-paths"],
            )
            .writing()
            .stopping_after(crate::core::deadline::LONG_WRITE_TIMEOUT_MS)
            .with_input(input.as_bytes()),
        )
        .await?
        .stdout,
    )?;
    let hashes: Result<Vec<String>, GitError> = output.split('\n').map(hash).collect();
    let hashes = hashes?;
    if hashes.len() != files.len() {
        return Err(malformed("hash-object path correspondence"));
    }
    let mut changed = String::new();
    for (entry, sha) in files.iter().zip(hashes.iter()) {
        if sha != &entry.sha {
            changed.push_str(&format!("{} {} 0\t{}\0", entry.mode, sha, entry.path));
        }
    }
    if changed.is_empty() {
        return Ok(tree.to_owned());
    }
    let index = TemporaryIndex::create(temp_directory)?;
    let env: Vec<(&str, &str)> = index
        .env()
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    checked(
        port,
        Command::new(root, &["read-tree", tree])
            .writing()
            .with_env(&env),
    )
    .await?;
    checked(
        port,
        Command::new(root, &["update-index", "-z", "--index-info"])
            .writing()
            .with_env(&env)
            .with_input(changed.as_bytes()),
    )
    .await?;
    hash(&text_output(
        &checked(
            port,
            Command::new(root, &["write-tree"]).writing().with_env(&env),
        )
        .await?
        .stdout,
    )?)
}

/// `recordBytes`: the bytes tree stays reachable under a ref named for the checkpoint commit.
pub async fn record_bytes(
    port: &dyn CommandPort,
    root: &str,
    thread_id: &str,
    checkpoint: &str,
    bytes: &str,
    created_at: &str,
) -> Result<(), GitError> {
    let commit = hash(&text_output(
        &checked(
            port,
            Command::new(root, &["-c", "commit.gpgSign=false", "commit-tree", bytes])
                .writing()
                .with_env(&ace_commit_env(created_at))
                .with_input(b"ace checkpoint bytes\n"),
        )
        .await?
        .stdout,
    )?)?;
    checked(
        port,
        Command::new(
            root,
            &[
                "update-ref",
                &format!("{}{checkpoint}", bytes_prefix(thread_id)?),
                &commit,
            ],
        )
        .writing(),
    )
    .await?;
    Ok(())
}

/// `checkpointBytes`: the files' own bytes for `checkpoint`, or its tree when none were
/// recorded beside it.
pub async fn checkpoint_bytes(
    port: &dyn CommandPort,
    root: &str,
    checkpoint: &Checkpoint,
) -> Result<String, GitError> {
    let found = checked(
        port,
        Command::new(
            root,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!(
                    "{}{}^{{tree}}",
                    bytes_prefix(&checkpoint.thread_id)?,
                    checkpoint.sha
                ),
            ],
        )
        .allowing_failure(),
    )
    .await?;
    match found.exit_code {
        0 => hash(&text_output(&found.stdout)?),
        1 => Ok(checkpoint.tree.clone()),
        _ => Err(GitError::new(GitErrorCode::GitFailed, found.stderr)),
    }
}

/// `forgetBytes`: the bytes refs of checkpoints the thread no longer has.
pub async fn forget_bytes(
    port: &dyn CommandPort,
    root: &str,
    thread_id: &str,
) -> Result<(), GitError> {
    let prefix = bytes_prefix(thread_id)?;
    let output = text_output(
        &checked(
            port,
            Command::new(
                root,
                &[
                    "for-each-ref",
                    "--format=%(refname)%00%(objectname)",
                    &prefix,
                ],
            ),
        )
        .await?
        .stdout,
    )?;
    if output.is_empty() {
        return Ok(());
    }
    let live: Vec<String> = checkpoint_refs(port, root, thread_id)
        .await?
        .into_iter()
        .map(|reference| reference.sha)
        .collect();
    let mut stale = Vec::new();
    for record in output.split('\n') {
        let fields: Vec<&str> = record.split('\0').collect();
        let [reference, sha] = fields.as_slice() else {
            return Err(malformed("checkpoint bytes ref"));
        };
        if !reference.starts_with(&prefix) {
            return Err(malformed("checkpoint bytes ref"));
        }
        let name = &reference[prefix.len()..];
        if !live.iter().any(|checked| checked == name) {
            stale.push(format!("delete {reference} {}", hash(sha)?));
        }
    }
    if stale.is_empty() {
        return Ok(());
    }
    let mut input = String::from("start\n");
    for line in stale {
        input.push_str(&line);
        input.push('\n');
    }
    input.push_str("prepare\ncommit\n");
    checked(
        port,
        Command::new(root, &["update-ref", "--stdin"])
            .writing()
            .with_input(input.as_bytes()),
    )
    .await?;
    Ok(())
}

/// `exactCheckoutArgs`: settings for a checkout that writes blobs as they are, or `None` when
/// this Git predates `--attr-source` (2.41).
pub async fn exact_checkout_args(
    port: &dyn CommandPort,
    root: &str,
) -> Result<Option<Vec<String>>, GitError> {
    let blob = hash(&text_output(
        &checked(
            port,
            Command::new(root, &["hash-object", "-w", "--no-filters", "--stdin"])
                .writing()
                .with_input(NEUTRAL_ATTRIBUTES.as_bytes()),
        )
        .await?
        .stdout,
    )?)?;
    let tree = hash(&text_output(
        &checked(
            port,
            Command::new(root, &["mktree"])
                .writing()
                .with_input(format!("100644 blob {blob}\t.gitattributes\n").as_bytes()),
        )
        .await?
        .stdout,
    )?)?;
    let probe = checked(
        port,
        Command::new(
            root,
            &[
                &format!("--attr-source={tree}"),
                "check-attr",
                "text",
                "--",
                "x",
            ],
        )
        .allowing_failure(),
    )
    .await?;
    if probe.exit_code != 0 {
        if probe.stderr.contains("attr-source") {
            return Ok(None);
        }
        return Err(GitError::new(GitErrorCode::GitFailed, probe.stderr));
    }
    Ok(Some(vec![
        String::from("-c"),
        String::from("core.autocrlf=false"),
        String::from("-c"),
        String::from("core.eol=lf"),
        String::from("-c"),
        String::from("core.safecrlf=false"),
        format!("--attr-source={tree}"),
    ]))
}

#[cfg(test)]
mod tests;
