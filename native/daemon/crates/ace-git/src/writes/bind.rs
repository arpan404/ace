// SPDX-License-Identifier: Apache-2.0
//! Serial turns, HEAD/index fingerprints and guarded working-tree writes for G4
//! mutations (`repository.serial`, compare-and-swap between observation and Git).

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::core::deadline::LONG_WRITE_TIMEOUT_MS;
use crate::core::decode::nul;
use crate::core::error::{GitError, GitErrorCode};
use crate::core::paths;
use crate::core::serial::{SerialTurn, global_serial};
use crate::reads::{Command, CommandPort, checked, text_output};

/// One checkout's HEAD OID and index bytes, observed under a serial turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckoutSnapshot {
    pub head: Option<String>,
    pub index: String,
}

fn head_moved(message: impl Into<String>) -> GitError {
    GitError::new(GitErrorCode::HeadMoved, message)
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

async fn index_path(port: &dyn CommandPort, root: &str) -> Result<String, GitError> {
    let output = checked(
        port,
        Command::new(
            root,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        ),
    )
    .await?;
    let path = text_output(&output.stdout)?;
    Ok(if Path::new(&path).is_absolute() {
        path
    } else {
        paths::resolve(root, &path)
    })
}

async fn index_bytes(port: &dyn CommandPort, root: &str) -> Result<Vec<u8>, GitError> {
    let path = index_path(port, root).await?;
    std::fs::read(&path).map_err(|error| GitError::from_io(&error))
}

/// The canonical root's turn for one write operation.
pub async fn serial_turn(root: &str) -> Result<(String, SerialTurn), GitError> {
    let key = paths::serial_key(root)?;
    let turn = global_serial().acquire(&key, None).await?;
    Ok((key, turn))
}

/// HEAD and the index digest under an already-acquired serial turn.
pub async fn checkout_snapshot(
    port: &dyn CommandPort,
    root: &str,
) -> Result<CheckoutSnapshot, GitError> {
    let head = crate::reads::info::head(port, root).await?;
    let bytes = index_bytes(port, root).await?;
    Ok(CheckoutSnapshot {
        head,
        index: digest(&bytes),
    })
}

impl CheckoutSnapshot {
    pub fn assert_head(&self, expected: Option<&str>) -> Result<(), GitError> {
        if self.head.as_deref() != expected {
            return Err(head_moved("HEAD moved; refresh first"));
        }
        Ok(())
    }

    pub async fn assert_index_unchanged(
        &self,
        port: &dyn CommandPort,
        root: &str,
    ) -> Result<(), GitError> {
        let bytes = index_bytes(port, root).await?;
        if digest(&bytes) != self.index {
            return Err(head_moved("The index changed meanwhile; refresh first"));
        }
        Ok(())
    }
}

/// A Git write that carries the long-write deadline TypeScript sets (`timeoutMs`, not the
/// output budget): a hung hook or a wait for input is stopped and reported as `git_timeout`.
pub fn long_writing(mut command: Command) -> Command {
    command.write = true;
    command.timeout_ms = Some(LONG_WRITE_TIMEOUT_MS);
    command
}

fn open_regular(root: &str, path: &str) -> Result<std::fs::File, GitError> {
    let root = paths::canonical(root).unwrap_or_else(|_| root.to_owned());
    let file = Path::new(&root).join(path);
    let parent = file.parent().ok_or_else(|| head_moved("Missing parent"))?;
    let real_parent = paths::canonical(&parent.to_string_lossy())
        .map_err(|_| head_moved("Path left the checkout"))?;
    if !paths::within(&root, &real_parent) {
        return Err(head_moved("Path left the checkout"));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options
        .open(&file)
        .map_err(|error| GitError::from_io(&error))
}

/// Write `content` only when `expected` still matches the open regular file.
pub fn guarded_regular_write(
    path: &str,
    root: &str,
    expected: &str,
    content: &str,
) -> Result<(), GitError> {
    let mut file = open_regular(root, path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| GitError::from_io(&error))?;
    if digest(&bytes) != expected {
        return Err(head_moved(format!(
            "{path} changed since it was read; refresh first"
        )));
    }
    let payload = content.as_bytes();
    file.seek(SeekFrom::Start(0))
        .map_err(|error| GitError::from_io(&error))?;
    file.set_len(0).map_err(|error| GitError::from_io(&error))?;
    file.write_all(payload)
        .map_err(|error| GitError::from_io(&error))?;
    file.sync_data()
        .map_err(|error| GitError::from_io(&error))?;
    Ok(())
}

async fn unmerged_stages(
    port: &dyn CommandPort,
    root: &str,
    path: &str,
) -> Result<[bool; 3], GitError> {
    let listed = checked(
        port,
        Command::new(root, &["ls-files", "--unmerged", "-z", "--", path])
            .with_env(&[("GIT_LITERAL_PATHSPECS", "1")]),
    )
    .await?;
    let mut stages = [false, false, false];
    for record in nul(&listed.stdout)? {
        let Some(tab) = record.find('\t') else {
            continue;
        };
        let header: Vec<&str> = record[..tab].split(' ').collect();
        let stage = header.last().copied();
        match stage {
            Some("1") => stages[0] = true,
            Some("2") => stages[1] = true,
            Some("3") => stages[2] = true,
            _ => {}
        }
    }
    if stages.iter().any(|present| *present) {
        Ok(stages)
    } else {
        Err(GitError::new(
            GitErrorCode::InvalidArgument,
            "No conflict to resolve",
        ))
    }
}

/// The bytes Git holds for one unmerged stage (`:1`, `:2`, `:3`).
pub async fn stage_bytes(
    port: &dyn CommandPort,
    root: &str,
    path: &str,
    stage: u8,
) -> Result<Vec<u8>, GitError> {
    let output = checked(
        port,
        Command::new(root, &["show", &format!(":{stage}:{path}")])
            .with_env(&[("GIT_LITERAL_PATHSPECS", "1")]),
    )
    .await?;
    Ok(output.stdout)
}

pub async fn assert_stages(
    port: &dyn CommandPort,
    root: &str,
    path: &str,
    stages: [bool; 3],
) -> Result<(), GitError> {
    let current = unmerged_stages(port, root, path).await?;
    if current != stages {
        return Err(head_moved(format!(
            "{path} changed since it was read; refresh first"
        )));
    }
    Ok(())
}

/// One index entry for a path: its mode, object id and stage (0 when it is resolved).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexEntry {
    pub mode: String,
    pub oid: String,
    pub stage: u32,
}

/// Every index entry `path` has, at each of its stages.
pub async fn index_entries(
    port: &dyn CommandPort,
    root: &str,
    path: &str,
) -> Result<Vec<IndexEntry>, GitError> {
    let listed = checked(
        port,
        Command::new(root, &["ls-files", "--stage", "-z", "--", path])
            .with_capture_bytes(8 * 1_048_576)
            .with_env(&[("GIT_LITERAL_PATHSPECS", "1")]),
    )
    .await?;
    let mut entries = Vec::new();
    for record in nul(&listed.stdout)? {
        let Some(tab) = record.find('\t') else {
            continue;
        };
        if record[tab + 1..] != *path {
            continue;
        }
        let header: Vec<&str> = record[..tab].split(' ').collect();
        let [mode, oid, stage] = match header.as_slice() {
            [mode, oid, stage] => [*mode, *oid, *stage],
            _ => {
                return Err(GitError::new(
                    GitErrorCode::MalformedOutput,
                    "Unreadable index entry",
                ));
            }
        };
        let Ok(stage) = stage.parse::<u32>() else {
            return Err(GitError::new(
                GitErrorCode::MalformedOutput,
                "Unreadable index entry",
            ));
        };
        entries.push(IndexEntry {
            mode: mode.to_owned(),
            oid: oid.to_owned(),
            stage,
        });
    }
    Ok(entries)
}

/// Puts the entries back exactly as they were, so a stage that took someone else's bytes is
/// not left in their place.
pub async fn restore_entries(
    port: &dyn CommandPort,
    root: &str,
    path: &str,
    entries: &[IndexEntry],
) -> Result<(), GitError> {
    checked(
        port,
        long_writing(
            Command::new(root, &["update-index", "--force-remove", "--", path])
                .with_env(&[("GIT_LITERAL_PATHSPECS", "1")]),
        ),
    )
    .await?;
    if entries.is_empty() {
        return Ok(());
    }
    let mut input = String::new();
    for entry in entries {
        input.push_str(&format!(
            "{} {} {}\t{path}\n",
            entry.mode, entry.oid, entry.stage
        ));
    }
    checked(
        port,
        long_writing(
            Command::new(root, &["update-index", "--index-info"])
                .with_input(input.as_bytes())
                .with_env(&[("GIT_LITERAL_PATHSPECS", "1")]),
        ),
    )
    .await?;
    Ok(())
}

/// The index must name exactly `expected` for `path` after a stage; anything else staged an
/// edit made meanwhile, so the recorded stages go back and the caller is refused.
pub async fn stage_exactly(
    port: &dyn CommandPort,
    root: &str,
    path: &str,
    expected: &str,
    before: &[IndexEntry],
) -> Result<(), GitError> {
    let entries = index_entries(port, root, path).await?;
    if entries.len() == 1 && entries[0].stage == 0 && entries[0].oid == expected {
        return Ok(());
    }
    restore_entries(port, root, path, before).await?;
    Err(head_moved(format!(
        "{path} changed since it was read; refresh first"
    )))
}

/// The blob `git add` writes for `content` at `path`, its filters included.
pub async fn blob_id(
    port: &dyn CommandPort,
    root: &str,
    path: &str,
    content: &str,
) -> Result<String, GitError> {
    let output = checked(
        port,
        Command::new(root, &["hash-object", "--stdin", &format!("--path={path}")])
            .with_input(content.as_bytes())
            .with_capture_bytes(4096),
    )
    .await?;
    text_output(&output.stdout)
}

/// `git add` only when the index stages for `path` still match.
pub async fn stage_literal(
    port: &dyn CommandPort,
    root: &str,
    path: &str,
    stages: Option<[bool; 3]>,
) -> Result<(), GitError> {
    if let Some(stages) = stages {
        assert_stages(port, root, path, stages).await?;
    }
    checked(
        port,
        long_writing(
            Command::new(root, &["add", "--", path]).with_env(&[("GIT_LITERAL_PATHSPECS", "1")]),
        ),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::deadline::LONG_WRITE_TIMEOUT_MS;

    #[test]
    fn long_writing_carries_the_six_hundred_second_deadline_not_the_output_budget() {
        let command = long_writing(Command::new("/repo", &["merge", "--abort"]));
        assert!(command.write);
        assert_eq!(command.timeout_ms, Some(LONG_WRITE_TIMEOUT_MS));
        // `stopAfterMs` resolves with partial output; the deadline must fail instead.
        assert_eq!(command.stop_after_ms, None);
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::reads::test_support::ProcessCommands;

    /// Runs a closure just before the first command whose own arguments name any word in `words`,
    /// so an intervening edit lands between a write's check and the Git step that acts on it.
    pub struct InterceptingCommands<'a> {
        pub inner: ProcessCommands<'a>,
        pub words: Vec<&'a str>,
        pub hook: Box<dyn Fn() + Send + Sync>,
        fired: std::sync::atomic::AtomicBool,
    }

    impl<'a> InterceptingCommands<'a> {
        pub fn before_word(
            inner: ProcessCommands<'a>,
            word: &'a str,
            hook: impl Fn() + Send + Sync + 'static,
        ) -> Self {
            Self::before_any(inner, &[word], hook)
        }

        pub fn before_any(
            inner: ProcessCommands<'a>,
            words: &[&'a str],
            hook: impl Fn() + Send + Sync + 'static,
        ) -> Self {
            Self {
                inner,
                words: words.to_vec(),
                hook: Box::new(hook),
                fired: std::sync::atomic::AtomicBool::new(false),
            }
        }

        pub fn fired(&self) -> bool {
            self.fired.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl CommandPort for InterceptingCommands<'_> {
        fn run_streaming<'a>(
            &'a self,
            command: Command,
            consume: &'a (dyn Fn(&[u8]) + Send + Sync),
        ) -> crate::core::spawn::BoxFuture<'a, Result<crate::reads::CommandOutput, GitError>>
        {
            self.inner.run_streaming(command, consume)
        }

        fn run(
            &self,
            command: Command,
        ) -> crate::core::spawn::BoxFuture<'_, Result<crate::reads::CommandOutput, GitError>>
        {
            if !self.fired.load(std::sync::atomic::Ordering::SeqCst)
                && command
                    .args
                    .iter()
                    .any(|arg| self.words.iter().any(|word| arg == word))
            {
                self.fired.store(true, std::sync::atomic::Ordering::SeqCst);
                (self.hook)();
            }
            self.inner.run(command)
        }
    }
}
