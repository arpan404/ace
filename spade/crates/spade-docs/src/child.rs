//! Running extraction where a hostile file cannot hurt the server: a child process (the server's
//! own binary, run with [`CHILD_ARG`]) that gets the bytes on stdin, answers one JSON line on
//! stdout and is killed past its deadline.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;

use crate::{DocError, Extracted, Limits, extract};

/// The argument that makes the server's binary a document reader.
pub const CHILD_ARG: &str = "extract-document";
/// The most a child may answer: the text cap, doubled for JSON escapes, and room.
const MOST_ANSWER: usize = 20 * 1024 * 1024;
/// Children running at once.
const MOST_CHILDREN: usize = 2;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Answer {
    Ok(Extracted),
    Error(DocError),
}

#[derive(Clone)]
enum How {
    InProcess,
    Child { program: PathBuf, args: Vec<String> },
}

/// Reads documents, in a child process or (for tests) in the caller.
#[derive(Clone)]
pub struct Extractor {
    how: How,
    limits: Limits,
    deadline: Duration,
    running: Arc<Semaphore>,
}

impl std::fmt::Debug for Extractor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Extractor").finish_non_exhaustive()
    }
}

impl Extractor {
    /// Reads in a child: `program` run with `args`, then [`CHILD_ARG`] and the file's name. The
    /// program must call [`serve_child`] when it sees [`CHILD_ARG`].
    pub fn child(program: PathBuf, args: Vec<String>) -> Self {
        Self::with(How::Child { program, args })
    }

    /// Reads in the caller, on the blocking pool. For tests, and where no child can be started.
    pub fn in_process() -> Self {
        Self::with(How::InProcess)
    }

    fn with(how: How) -> Self {
        Self {
            how,
            limits: Limits::default(),
            deadline: Duration::from_secs(20),
            running: Arc::new(Semaphore::new(MOST_CHILDREN)),
        }
    }

    /// The same reader with other limits (for an in-process reader; a child uses the defaults).
    #[must_use]
    pub fn with_limits(mut self, limits: Limits) -> Self {
        self.limits = limits;
        self
    }

    #[must_use]
    pub fn with_deadline(mut self, deadline: Duration) -> Self {
        self.deadline = deadline;
        self
    }

    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    /// The text of `bytes`, the file named `name`.
    pub async fn read(&self, bytes: Vec<u8>, name: &str) -> Result<Extracted, DocError> {
        if bytes.len() > self.limits.file_bytes {
            return Err(DocError::TooLarge(self.limits.file_bytes / (1024 * 1024)));
        }
        let _permit = self
            .running
            .acquire()
            .await
            .map_err(|_| DocError::Failed("Spade is stopping".to_owned()))?;
        let seconds = self.deadline.as_secs().max(1);
        match &self.how {
            How::InProcess => {
                let limits = self.limits;
                let name = name.to_owned();
                let work = tokio::task::spawn_blocking(move || extract(&bytes, &name, &limits));
                match tokio::time::timeout(self.deadline, work).await {
                    Ok(Ok(result)) => result,
                    Ok(Err(_)) => Err(DocError::Failed("the reader stopped".to_owned())),
                    Err(_) => Err(DocError::TimedOut(seconds)),
                }
            }
            How::Child { program, args } => {
                let run = run_child(program, args, &bytes, name);
                match tokio::time::timeout(self.deadline, run).await {
                    Ok(result) => result,
                    // Dropping the run kills the child (`kill_on_drop`).
                    Err(_) => Err(DocError::TimedOut(seconds)),
                }
            }
        }
    }
}

async fn run_child(
    program: &PathBuf,
    args: &[String],
    bytes: &[u8],
    name: &str,
) -> Result<Extracted, DocError> {
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .arg(CHILD_ARG)
        .arg(name)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| DocError::Failed(format!("the reader did not start: {}", e.kind())))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| DocError::Failed("the reader has no input".to_owned()))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| DocError::Failed("the reader has no output".to_owned()))?;
    let input = bytes.to_vec();
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(&input).await;
        let _ = stdin.shutdown().await;
    });
    let mut answer = Vec::new();
    let read = (&mut stdout)
        .take(MOST_ANSWER as u64 + 1)
        .read_to_end(&mut answer)
        .await;
    writer.abort();
    let _ = child.kill().await;
    if read.is_err() || answer.len() > MOST_ANSWER {
        return Err(DocError::Failed(
            "the reader's answer was too long".to_owned(),
        ));
    }
    match serde_json::from_slice::<Answer>(&answer) {
        Ok(Answer::Ok(extracted)) => Ok(extracted),
        Ok(Answer::Error(error)) => Err(error),
        Err(_) => Err(DocError::Failed(
            "the reader stopped without an answer".to_owned(),
        )),
    }
}

/// The child's side: reads the file from `input`, answers on `output`. `name` is the argument
/// after [`CHILD_ARG`]. Returns the exit code.
pub fn serve_child(name: &str, input: &mut dyn Read, output: &mut dyn Write) -> i32 {
    let limits = Limits::default();
    let mut bytes = Vec::new();
    let answer = match input
        .take(limits.file_bytes as u64 + 1)
        .read_to_end(&mut bytes)
    {
        Ok(_) => match extract(&bytes, name, &limits) {
            Ok(extracted) => Answer::Ok(extracted),
            Err(error) => Answer::Error(error),
        },
        Err(_) => Answer::Error(DocError::Failed("the file could not be read".to_owned())),
    };
    let written = serde_json::to_writer(&mut *output, &answer).is_ok() && output.flush().is_ok();
    i32::from(!written)
}
