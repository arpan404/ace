// SPDX-License-Identifier: Apache-2.0
//! Review lines from one immutable revision (`packages/git/src/revision-lines.ts`, G3c):
//! `cat-file blob` streamed into one bounded line window.
//!
//! Proof: `history.process` and `review-regressions.process`'s revision-line cases. A
//! checkpoint revision needs G5's `readCheckpoint` and stays in TypeScript until then.

use crate::core::decode::path_schema;
use crate::core::error::{GitError, GitErrorCode};
use crate::core::utf8_stream::Utf8StreamDecoder;
use crate::reads::line_window::{LineWindow, RevisionLines};
use crate::reads::{Command, CommandPort, checked_streaming};

/// The most characters one window may carry.
pub const REVIEW_MAX_CHARS: usize = 8192;
/// The highest line number a window may name.
pub const REVIEW_MAX_LINE: u64 = 10_000_003;
/// The most lines one range may span.
pub const REVIEW_MAX_SPAN: u64 = 106;

/// A revision this read can serve: a commit id. A checkpoint arrives with G5.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewRevision {
    Commit(String),
}

fn invalid(message: String) -> GitError {
    GitError::new(GitErrorCode::InvalidArgument, message)
}

/// `readRevisionLines`: the requested lines of `path` at an immutable revision.
pub async fn read_revision_lines(
    port: &dyn CommandPort,
    root: &str,
    revision: &ReviewRevision,
    path: &str,
    start: u64,
    end: u64,
) -> Result<RevisionLines, GitError> {
    if start < 1 || end < 1 || start > REVIEW_MAX_LINE || end > REVIEW_MAX_LINE {
        return Err(invalid("Review line range is out of bounds".to_owned()));
    }
    if end < start || end - start >= REVIEW_MAX_SPAN {
        return Err(invalid("Review line range is out of bounds".to_owned()));
    }
    let path = path_schema(path).ok_or_else(|| invalid(format!("Invalid review path: {path}")))?;
    let ReviewRevision::Commit(reference) = revision;
    let sha = crate::reads::diff::resolve_commit(port, root, reference).await?;
    // `captureBytes: 0` + `consume`: the blob is decoded and windowed as it arrives, and the
    // port holds none of it (a sequence split across chunks is carried, not replaced).
    let state = std::sync::Mutex::new((
        LineWindow::new(start, end, REVIEW_MAX_CHARS),
        Utf8StreamDecoder::default(),
    ));
    let consume = |chunk: &[u8]| {
        if let Ok(mut locked) = state.lock() {
            let (window, decoder) = &mut *locked;
            window.append(&decoder.write(chunk));
        }
    };
    checked_streaming(
        port,
        Command::new(root, &["cat-file", "blob", &format!("{sha}:{path}")]).with_capture_bytes(0),
        &consume,
    )
    .await?;
    if let Ok(mut locked) = state.lock() {
        let (window, decoder) = &mut *locked;
        window.append(&decoder.end());
        drop(locked);
    }
    state
        .into_inner()
        .unwrap_or_else(|poison| poison.into_inner())
        .0
        .finish()
        .ok_or_else(|| {
            GitError::new(
                GitErrorCode::OutputTooLarge,
                "Review line window exceeds 8192 characters",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::core::spawn::BoxFuture;
    use crate::reads::CommandOutput;
    use crate::reads::test_support::ProcessCommands;

    #[tokio::test]
    async fn a_window_reads_only_the_requested_lines_and_its_end_of_file_facts() {
        let fixture = Fixture::new("g3c-lines");
        let repo = fixture.repository("repo");
        std::fs::write(repo.join("file.txt"), "one\ntwo\nthree\nfour\n").expect("file");
        fixture.git(&repo, &["commit", "--quiet", "-am", "lines"]);
        let head = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        let port = ProcessCommands { fixture: &fixture };
        let revision = ReviewRevision::Commit(head.clone());
        let lines =
            read_revision_lines(&port, &repo.to_string_lossy(), &revision, "file.txt", 2, 3)
                .await
                .expect("lines");
        assert_eq!(
            lines,
            RevisionLines {
                lines: vec!["two".to_owned(), "three".to_owned()],
                at_eof: false,
                no_final_newline: false,
            }
        );
        let tail = read_revision_lines(&port, &repo.to_string_lossy(), &revision, "file.txt", 4, 4)
            .await
            .expect("tail");
        assert!(tail.at_eof);
    }

    #[tokio::test]
    async fn the_range_path_and_revision_bounds_are_typed() {
        let fixture = Fixture::new("g3c-lines-bounds");
        let repo = fixture.repository("repo");
        let port = ProcessCommands { fixture: &fixture };
        let revision = ReviewRevision::Commit("HEAD".to_owned());
        let root = repo.to_string_lossy();
        for (start, end) in [
            (0, 1),
            (1, 0),
            (5, 4),
            (1, 107),
            (REVIEW_MAX_LINE + 1, REVIEW_MAX_LINE + 1),
        ] {
            let error = read_revision_lines(&port, &root, &revision, "file.txt", start, end)
                .await
                .expect_err("range");
            assert_eq!(error.code, GitErrorCode::InvalidArgument, "{start}-{end}");
        }
        for path in ["../file", "/file", ""] {
            let error = read_revision_lines(&port, &root, &revision, path, 1, 1)
                .await
                .expect_err(path);
            assert_eq!(error.code, GitErrorCode::InvalidArgument, "{path}");
        }
        let unknown = ReviewRevision::Commit("no-such-ref".to_owned());
        let error = read_revision_lines(&port, &root, &unknown, "file.txt", 1, 1)
            .await
            .expect_err("revision");
        assert_eq!(error.code, GitErrorCode::InvalidRef);
    }

    /// A streamed read: the port hands the blob over one byte at a time, as a pipe may.
    struct ByteAtATime {
        content: Vec<u8>,
    }

    impl CommandPort for ByteAtATime {
        fn run(&self, _command: Command) -> BoxFuture<'_, Result<CommandOutput, GitError>> {
            Box::pin(async move {
                // `resolveCommit` asks for the revision's commit before the blob.
                Ok(CommandOutput {
                    stdout: format!("{SHA}\n").into_bytes(),
                    stderr: String::new(),
                    exit_code: 0,
                    truncated: false,
                    stopped: None,
                })
            })
        }

        fn run_streaming<'a>(
            &'a self,
            _command: Command,
            consume: &'a (dyn Fn(&[u8]) + Send + Sync),
        ) -> BoxFuture<'a, Result<CommandOutput, GitError>> {
            Box::pin(async move {
                for byte in &self.content {
                    consume(std::slice::from_ref(byte));
                }
                Ok(CommandOutput {
                    stdout: Vec::new(),
                    stderr: String::new(),
                    exit_code: 0,
                    truncated: false,
                    stopped: None,
                })
            })
        }
    }

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    // `StringDecoder` carries an incomplete sequence into the next chunk: a streamed read whose
    // chunks split an emoji still windows the character, not two replacements.
    #[tokio::test]
    async fn a_character_split_across_streamed_chunks_is_not_corrupted() {
        let port = ByteAtATime {
            content: "\u{1F600}\u{1F600} ok\n".as_bytes().to_vec(),
        };
        let revision = ReviewRevision::Commit("HEAD".to_owned());
        let lines = read_revision_lines(&port, "/repo", &revision, "file.txt", 1, 1)
            .await
            .expect("lines");
        assert_eq!(lines.lines, vec!["\u{1F600}\u{1F600} ok".to_owned()]);
    }

    /// A port whose whole-capture path refuses a blob: the core fails a metadata capture past
    /// its bound ("Git metadata exceeded 64 MiB") rather than hand the caller a whole file.
    struct CaptureRefused {
        content: Vec<u8>,
    }

    impl CommandPort for CaptureRefused {
        fn run(&self, command: Command) -> BoxFuture<'_, Result<CommandOutput, GitError>> {
            Box::pin(async move {
                if command.args.first().is_some_and(|arg| arg == "rev-parse") {
                    return Ok(CommandOutput {
                        stdout: format!("{SHA}\n").into_bytes(),
                        stderr: String::new(),
                        exit_code: 0,
                        truncated: false,
                        stopped: None,
                    });
                }
                Err(GitError::new(
                    GitErrorCode::OutputTooLarge,
                    "Git metadata exceeded 64 MiB",
                ))
            })
        }

        fn run_streaming<'a>(
            &'a self,
            command: Command,
            consume: &'a (dyn Fn(&[u8]) + Send + Sync),
        ) -> BoxFuture<'a, Result<CommandOutput, GitError>> {
            Box::pin(async move {
                if command.capture_bytes != Some(0) {
                    return Err(GitError::new(
                        GitErrorCode::OutputTooLarge,
                        "Git metadata exceeded 64 MiB",
                    ));
                }
                for chunk in self.content.chunks(8 * 1024) {
                    consume(chunk);
                }
                Ok(CommandOutput {
                    stdout: Vec::new(),
                    stderr: String::new(),
                    exit_code: 0,
                    truncated: false,
                    stopped: None,
                })
            })
        }
    }

    // `captureBytes: 0` + `consume`: the read never asks the port for the blob, so a capture
    // bound can't refuse it and the window is read from the stream.
    #[tokio::test]
    async fn a_window_is_read_from_a_blob_that_a_whole_capture_refuses() {
        let port = CaptureRefused {
            content: b"first\nsecond\n".to_vec(),
        };
        let revision = ReviewRevision::Commit("HEAD".to_owned());
        let lines = read_revision_lines(&port, "/repo", &revision, "file.txt", 2, 2)
            .await
            .expect("streamed lines");
        assert_eq!(lines.lines, vec!["second".to_owned()]);
    }

    /// A port delivering explicit raw chunks, enforcing `capture_bytes == Some(0)`.
    struct ExplicitChunks {
        chunks: Vec<Vec<u8>>,
    }

    impl CommandPort for ExplicitChunks {
        fn run(&self, _command: Command) -> BoxFuture<'_, Result<CommandOutput, GitError>> {
            Box::pin(async move {
                Ok(CommandOutput {
                    stdout: format!("{SHA}\n").into_bytes(),
                    stderr: String::new(),
                    exit_code: 0,
                    truncated: false,
                    stopped: None,
                })
            })
        }

        fn run_streaming<'a>(
            &'a self,
            command: Command,
            consume: &'a (dyn Fn(&[u8]) + Send + Sync),
        ) -> BoxFuture<'a, Result<CommandOutput, GitError>> {
            Box::pin(async move {
                if command.capture_bytes != Some(0) {
                    return Err(GitError::new(
                        GitErrorCode::OutputTooLarge,
                        "expected capture_bytes == Some(0)",
                    ));
                }
                for chunk in &self.chunks {
                    consume(chunk);
                }
                Ok(CommandOutput {
                    stdout: Vec::new(),
                    stderr: String::new(),
                    exit_code: 0,
                    truncated: false,
                    stopped: None,
                })
            })
        }
    }

    #[tokio::test]
    async fn split_utf8_followed_by_invalid_byte_and_ascii_decodes_like_string_decoder() {
        let port = ExplicitChunks {
            chunks: vec![vec![0xC3], vec![0xA9, 0xFF, 0x61, 0x0A]],
        };
        let revision = ReviewRevision::Commit("HEAD".to_owned());
        let lines = read_revision_lines(&port, "/repo", &revision, "file.txt", 1, 1)
            .await
            .expect("lines");
        assert_eq!(
            lines,
            RevisionLines {
                lines: vec!["\u{00E9}\u{FFFD}a".to_owned()],
                at_eof: true,
                no_final_newline: false,
            }
        );
    }

    /// Wraps the real process port and records the maximum stdout bytes retained by any
    /// streaming call so the test fails if `cat-file blob` ever captures stdout.
    struct ObservingProcess<'a> {
        inner: ProcessCommands<'a>,
        retained_streaming_stdout: std::sync::atomic::AtomicUsize,
    }

    impl CommandPort for ObservingProcess<'_> {
        fn run(&self, command: Command) -> BoxFuture<'_, Result<CommandOutput, GitError>> {
            self.inner.run(command)
        }

        fn run_streaming<'a>(
            &'a self,
            command: Command,
            consume: &'a (dyn Fn(&[u8]) + Send + Sync),
        ) -> BoxFuture<'a, Result<CommandOutput, GitError>> {
            Box::pin(async move {
                let output = self.inner.run_streaming(command, consume).await?;
                self.retained_streaming_stdout
                    .fetch_max(output.stdout.len(), std::sync::atomic::Ordering::SeqCst);
                Ok(output)
            })
        }
    }

    #[tokio::test]
    async fn a_small_window_at_the_end_of_a_blob_over_capture_bound_streams_without_retaining_stdout()
     {
        let fixture = Fixture::new("g3c-large-blob");
        let repo = fixture.repository("repo");
        fixture.git(&repo, &["config", "user.email", "t@example.invalid"]);
        fixture.git(&repo, &["config", "user.name", "T"]);
        // Strictly larger than DEFAULT_CAPTURE_BYTES (64 MiB): 65,600 * 1024 B = 67,174,400 B.
        let line_count: u64 = 65_600;
        let line = format!("{}\n", "a".repeat(1023));
        {
            use std::io::{BufWriter, Write};
            let file = std::fs::File::create(repo.join("big.txt")).expect("create big");
            let mut writer = BufWriter::new(file);
            for _ in 0..line_count {
                writer.write_all(line.as_bytes()).expect("write line");
            }
            writer
                .write_all("tail \u{1F600}\n".as_bytes())
                .expect("tail");
            writer.flush().expect("flush");
        }
        assert!(
            std::fs::metadata(repo.join("big.txt")).expect("meta").len()
                > crate::core::cli::DEFAULT_CAPTURE_BYTES as u64
        );
        fixture.git(&repo, &["add", "big.txt"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "big"]);
        let port = ObservingProcess {
            inner: ProcessCommands { fixture: &fixture },
            retained_streaming_stdout: std::sync::atomic::AtomicUsize::new(0),
        };
        let revision = ReviewRevision::Commit("HEAD".to_owned());
        let lines = read_revision_lines(
            &port,
            &repo.to_string_lossy(),
            &revision,
            "big.txt",
            line_count + 1,
            line_count + 1,
        )
        .await
        .expect("tail");
        assert_eq!(lines.lines, vec!["tail \u{1F600}".to_owned()]);
        assert!(lines.at_eof);
        assert_eq!(
            port.retained_streaming_stdout
                .load(std::sync::atomic::Ordering::SeqCst),
            0,
            "streaming cat-file must not retain stdout"
        );
    }

    #[tokio::test]
    async fn a_window_past_its_character_budget_is_output_too_large() {
        let fixture = Fixture::new("g3c-lines-budget");
        let repo = fixture.repository("repo");
        std::fs::write(repo.join("file.txt"), "\u{1F600}".repeat(5000)).expect("file");
        fixture.git(&repo, &["commit", "--quiet", "-am", "big"]);
        let port = ProcessCommands { fixture: &fixture };
        let revision = ReviewRevision::Commit("HEAD".to_owned());
        let error =
            read_revision_lines(&port, &repo.to_string_lossy(), &revision, "file.txt", 1, 1)
                .await
                .expect_err("budget");
        assert_eq!(error.code, GitErrorCode::OutputTooLarge);
    }
}
