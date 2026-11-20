// SPDX-License-Identifier: Apache-2.0

//! One timed search: through a fresh `ace-files` over the wire, or through `rg` on the same tree.
//!
//! ace's peak memory is the whole process's: it includes the root's quick-open index and watcher,
//! which a search waits for before it starts.
//!
//! Both run under `/usr/bin/time` when the machine has it, which reports the process's CPU time and peak resident set
//! when it exits. ace is timed from the `search` request to its `searchDone` event (the daemon
//! keeps the process running, so start-up is not part of what a person waits for); `rg` is timed
//! from spawn to its exit, start-up included. A capped query reads `rg`'s first lines and then
//! closes the pipe, which is what `rg ... | head -n N` does.

use std::error::Error;
use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use files_wire::{Case, EventPayload, Op, Reply, SearchQuery};

use crate::wire::Wire;

/// The longest one search may take before the run fails.
const DEADLINE: Duration = Duration::from_secs(600);

/// The per-file cap the daemon asks for by default (4 MiB), applied to both tools.
pub const FILE_CAP: u64 = 4 * 1024 * 1024;

/// One query as both tools spell it.
#[derive(Clone)]
pub struct Query {
    pub name: &'static str,
    pub pattern: String,
    pub regex: bool,
    pub insensitive: bool,
    pub word: bool,
    /// Matches after which ace stops; 0 for none. `rg` stops after this many lines instead.
    pub cap: u64,
}

/// What one run measured.
#[derive(Clone, Copy, Default)]
pub struct Sample {
    /// When the first result reached the reader, if any did.
    pub first: Option<Duration>,
    pub total: Duration,
    /// User plus system CPU of the whole process; none without `/usr/bin/time`.
    pub cpu: Option<Duration>,
    /// Peak resident bytes; none without `/usr/bin/time`.
    pub peak_rss: Option<u64>,
    /// Matching lines seen: ace's line matches, `rg`'s output lines.
    pub lines: u64,
}

/// Search `root` through a fresh ace-files process.
pub fn ace(
    binary: &Path,
    root: &Path,
    query: &Query,
    scratch: &Path,
) -> Result<Sample, Box<dyn Error>> {
    let report = scratch.join("ace-time.txt");
    let mut command = timed(binary.as_os_str());
    command.stderr(Stdio::from(fs::File::create(&report)?));
    let mut wire = Wire::spawn(command)?;
    wire.begin_phase("search", DEADLINE);
    let measured = ace_search(&mut wire, root, query);
    wire.stop();
    let mut sample = measured?;
    if timing() {
        let (cpu, peak_rss) = usage(&fs::read_to_string(&report)?)?;
        sample.cpu = Some(cpu);
        sample.peak_rss = Some(peak_rss);
    }
    Ok(sample)
}

fn ace_search(wire: &mut Wire, root: &Path, query: &Query) -> Result<Sample, Box<dyn Error>> {
    wire.hello()?;
    let root = match wire.ask(Op::OpenRoot {
        path: root.to_string_lossy().into_owned(),
    })? {
        Reply::Root { root } => root,
        other => return Err(format!("openRoot answered {other:?}").into()),
    };
    // Opening a root starts its quick-open index and its watcher. The daemon keeps roots open, so
    // a person's search meets a root that finished both long ago: wait for the index, then time.
    loop {
        match wire.ask(Op::IndexQuery {
            root,
            query: String::new(),
            limit: 1,
        })? {
            Reply::Index(index) if index.ready => break,
            Reply::Index(_) => std::thread::sleep(Duration::from_millis(50)),
            other => return Err(format!("indexQuery answered {other:?}").into()),
        }
    }
    let started = Instant::now();
    let subscription = match wire.ask(Op::Search {
        root,
        query: SearchQuery {
            pattern: query.pattern.clone(),
            regex: query.regex,
            case: if query.insensitive {
                Case::Insensitive
            } else {
                Case::Sensitive
            },
            whole_word: query.word,
            include: Vec::new(),
            exclude: Vec::new(),
            include_ignored: false,
            max_matches: query.cap,
            max_file_bytes: FILE_CAP,
        },
    })? {
        Reply::Subscription { subscription } => subscription,
        other => return Err(format!("search answered {other:?}").into()),
    };
    let mut sample = Sample::default();
    loop {
        match wire.try_event(subscription, DEADLINE)? {
            Some((at, EventPayload::Matches { file })) => {
                sample.first.get_or_insert(at - started);
                sample.lines += file.lines.len() as u64;
            }
            Some((at, EventPayload::SearchDone { .. })) => {
                sample.total = at - started;
                return Ok(sample);
            }
            Some((_, EventPayload::SearchFailed { code, message })) => {
                return Err(format!("the search failed: {code}: {message}").into());
            }
            Some(_) => {}
            None => return Err("the search sent nothing before its deadline".into()),
        }
    }
}

/// Search `root` with `rg`, flags chosen to search what ace searches.
pub fn rg(rg: &Path, root: &Path, query: &Query, scratch: &Path) -> Result<Sample, Box<dyn Error>> {
    let report = scratch.join("rg-time.txt");
    let mut command = timed(rg.as_os_str());
    command
        .current_dir(root)
        .args(rg_args(query))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(fs::File::create(&report)?));
    let started = Instant::now();
    let mut child = command.spawn()?;
    let mut stdout = child.stdout.take().ok_or("rg has no stdout")?;
    let mut sample = Sample::default();
    let mut buffer = vec![0; 256 * 1024];
    // Set once the bench has read the cap's worth of lines and is about to close the pipe.
    let mut closed_early = false;
    loop {
        let read = stdout.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        sample.first.get_or_insert_with(|| started.elapsed());
        sample.lines += buffer[..read].iter().filter(|&&byte| byte == b'\n').count() as u64;
        if query.cap > 0 && sample.lines >= query.cap {
            closed_early = true;
            break;
        }
    }
    // Closing the pipe stops a capped `rg` the way `head` does.
    drop(stdout);
    let status = child.wait()?;
    sample.total = started.elapsed();
    if !finished_cleanly(status, closed_early) {
        return Err(format!("rg exited with {status} after {} lines", sample.lines).into());
    }
    if timing() {
        let (cpu, peak_rss) = usage(&fs::read_to_string(&report)?)?;
        sample.cpu = Some(cpu);
        sample.peak_rss = Some(peak_rss);
    }
    Ok(sample)
}

/// Whether `rg`'s exit is one a sample may keep: success, 1 (no match, which rg also reports when
/// it stops at a closed pipe), or, once the bench closed the pipe after the cap, the broken-pipe
/// death that closing causes (SIGPIPE, which `/usr/bin/time` passes on as 141). Status 2 or any
/// other signal is a failure, whenever it happens.
fn finished_cleanly(status: std::process::ExitStatus, closed_early: bool) -> bool {
    if status.success() || status.code() == Some(1) {
        return true;
    }
    closed_early && broken_pipe(status)
}

#[cfg(unix)]
fn broken_pipe(status: std::process::ExitStatus) -> bool {
    use std::os::unix::process::ExitStatusExt;

    /// The signal a write to a closed pipe raises.
    const SIGPIPE: i32 = 13;
    status.signal() == Some(SIGPIPE) || status.code() == Some(128 + SIGPIPE)
}

#[cfg(not(unix))]
fn broken_pipe(_status: std::process::ExitStatus) -> bool {
    false
}

/// The `rg` flags for ace's rules: hidden files searched, `.git` never entered, git's ignore
/// files at and below the root and `.git/info/exclude` honoured without needing a repository,
/// nothing from above the root or the user's global excludes, line numbers on, files over the
/// daemon's per-file cap skipped.
pub fn rg_args(query: &Query) -> Vec<String> {
    let mut args = vec![
        "--line-number".to_owned(),
        "--no-heading".to_owned(),
        "--color=never".to_owned(),
        "--hidden".to_owned(),
        "--glob=!.git".to_owned(),
        "--no-ignore-parent".to_owned(),
        "--no-ignore-global".to_owned(),
        "--no-require-git".to_owned(),
        format!("--max-filesize={FILE_CAP}"),
    ];
    if !query.regex {
        args.push("--fixed-strings".to_owned());
    }
    if query.insensitive {
        args.push("--ignore-case".to_owned());
    }
    if query.word {
        args.push("--word-regexp".to_owned());
    }
    args.push("--regexp".to_owned());
    args.push(query.pattern.clone());
    args.push("./".to_owned());
    args
}

/// Where the external `time` lives; a machine without it still gets wall times.
const TIME: &str = "/usr/bin/time";

/// Whether CPU and peak memory can be measured here.
pub fn timing() -> bool {
    Path::new(TIME).is_file()
}

/// `/usr/bin/time` around `program`, in the form that reports peak memory, or `program` alone
/// when the machine has no `/usr/bin/time`.
fn timed(program: &std::ffi::OsStr) -> Command {
    if !timing() {
        return Command::new(program);
    }
    let mut command = Command::new(TIME);
    command.arg(if cfg!(target_os = "macos") {
        "-l"
    } else {
        "-v"
    });
    command.arg(program);
    command
}

/// CPU time and peak resident bytes from `/usr/bin/time`'s report (BSD `-l` or GNU `-v`).
fn usage(report: &str) -> Result<(Duration, u64), Box<dyn Error>> {
    let mut user = None;
    let mut system = None;
    let mut rss = None;
    for line in report.lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        if let [.., u, "user", s, "sys"] = words.as_slice() {
            user = u.parse::<f64>().ok();
            system = s.parse::<f64>().ok();
        } else if line.contains("maximum resident set size") {
            rss = words.first().and_then(|value| value.parse::<u64>().ok());
        } else if let Some(value) = line.trim().strip_prefix("User time (seconds): ") {
            user = value.parse().ok();
        } else if let Some(value) = line.trim().strip_prefix("System time (seconds): ") {
            system = value.parse().ok();
        } else if let Some(value) = line
            .trim()
            .strip_prefix("Maximum resident set size (kbytes): ")
        {
            rss = value.parse::<u64>().ok().map(|kib| kib * 1024);
        }
    }
    match (user, system, rss) {
        (Some(user), Some(system), Some(rss)) => Ok((Duration::from_secs_f64(user + system), rss)),
        _ => Err(format!("cannot read /usr/bin/time's report: {report:?}").into()),
    }
}

/// The scratch folder for `/usr/bin/time` reports.
pub fn scratch(target: &Path) -> Result<PathBuf, Box<dyn Error>> {
    let path = target.join("bench/search-scratch");
    fs::create_dir_all(&path)?;
    Ok(path)
}
