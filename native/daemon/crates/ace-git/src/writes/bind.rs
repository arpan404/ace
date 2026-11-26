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

/// A Git write that carries the long-write deadline TypeScript sets.
pub fn long_writing(mut command: Command) -> Command {
    command.write = true;
    command.stop_after_ms = Some(LONG_WRITE_TIMEOUT_MS);
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
    fn long_writing_carries_the_six_hundred_second_deadline() {
        let command = long_writing(Command::new("/repo", &["merge", "--abort"]));
        assert!(command.write);
        assert_eq!(command.stop_after_ms, Some(LONG_WRITE_TIMEOUT_MS));
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::reads::test_support::ProcessCommands;

    /// Runs a closure after `after` git commands, so intervening edits hit compare-and-swap.
    pub struct InterceptingCommands<'a> {
        pub inner: ProcessCommands<'a>,
        pub after: usize,
        pub hook: Box<dyn Fn() + Send + Sync>,
        pub seen: std::sync::atomic::AtomicUsize,
    }

    impl CommandPort for InterceptingCommands<'_> {
        fn run(
            &self,
            command: Command,
        ) -> crate::core::spawn::BoxFuture<'_, Result<crate::reads::CommandOutput, GitError>>
        {
            let count = self.seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if count == self.after {
                (self.hook)();
            }
            self.inner.run(command)
        }
    }
}
