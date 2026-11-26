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
    // `captureBytes: 0` + `consume`: the blob is decoded and windowed as it arrives, never held
    // whole. The default port hands the bytes over in one piece; the wiring streams them.
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
    let _streamed = checked_streaming(
        port,
        Command::new(root, &["cat-file", "blob", &format!("{sha}:{path}")]),
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

    #[tokio::test]
    async fn an_emoji_split_across_streamed_chunks_stays_intact_in_the_window() {
        let fixture = Fixture::new("g3c-chunk-emoji");
        let repo = fixture.repository("repo");
        fixture.git(&repo, &["config", "user.email", "t@example.invalid"]);
        fixture.git(&repo, &["config", "user.name", "T"]);
        std::fs::write(repo.join("e.txt"), format!("{}\n", "\u{1F600}")).expect("file");
        fixture.git(&repo, &["add", "e.txt"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "emoji"]);
        let port = ProcessCommands { fixture: &fixture };
        let revision = ReviewRevision::Commit("HEAD".to_owned());
        let lines = read_revision_lines(&port, &repo.to_string_lossy(), &revision, "e.txt", 1, 1)
            .await
            .expect("lines");
        assert_eq!(lines.lines, vec!["\u{1F600}".to_owned()]);
    }

    #[tokio::test]
    async fn a_small_window_at_the_end_of_a_large_blob_reads_correctly() {
        let fixture = Fixture::new("g3c-large-blob");
        let repo = fixture.repository("repo");
        fixture.git(&repo, &["config", "user.email", "t@example.invalid"]);
        fixture.git(&repo, &["config", "user.name", "T"]);
        let mut content = String::new();
        for index in 0..500 {
            content.push_str(&format!("line {index}\n"));
        }
        content.push_str("tail\n");
        std::fs::write(repo.join("big.txt"), content).expect("big");
        fixture.git(&repo, &["add", "big.txt"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "big"]);
        let port = ProcessCommands { fixture: &fixture };
        let revision = ReviewRevision::Commit("HEAD".to_owned());
        let lines = read_revision_lines(
            &port,
            &repo.to_string_lossy(),
            &revision,
            "big.txt",
            501,
            501,
        )
        .await
        .expect("tail");
        assert_eq!(lines.lines, vec!["tail".to_owned()]);
        assert!(lines.at_eof);
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
