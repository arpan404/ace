// SPDX-License-Identifier: Apache-2.0

//! The checkout the content-search bench measures: generated once, reused while its marker says
//! it is the same tree.
//!
//! Every file is a pure function of its number, so a given `--files` always writes the same tree.
//! Out of every thousand files, 200 sit in a gitignored `node_modules`, 20 are binaries (a NUL in
//! their first bytes), 10 sit in a gitignored `dist`, 5 are minified scripts with one long line,
//! and the rest are source files of mixed sizes: most a few kilobytes, a few hundred kilobytes and
//! a handful near a megabyte. Source lines come from a small vocabulary so common words are common,
//! and the rare literal sits in about one source file in twenty thousand.
//!
//! The folder is the bench's only when it carries the ownership marker the bench created
//! exclusively: a regular file, never a link, holding exactly the bench's text. A non-empty folder
//! without it is refused, a run holds an exclusive lock on it, and regenerating removes only the
//! entries the generator writes, so anything else in the folder survives.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Created exclusively before any file is written; the only thing that lets a run empty the folder.
const OWNER: &str = ".ace-search-bench-owned";
/// Written last: its presence and content mean a complete tree of this shape.
const MARKER: &str = ".ace-search-bench-tree";
/// Locked for the whole run.
const LOCK: &str = ".ace-search-bench-lock";
/// What the ownership marker holds. A marker with anything else in it is not ours.
const OWNER_TEXT: &str = "ace-files search bench folder\n";
/// Every top-level entry the generator writes; regenerating removes these and nothing else.
const GENERATED: [&str; 8] = [
    ".gitignore",
    ".git",
    "node_modules",
    "assets",
    "dist",
    "web",
    "src",
    MARKER,
];
/// Bumped whenever the generator changes, so an old tree is not reused.
const VERSION: u32 = 1;
/// Files per leaf folder.
const PER_FOLDER: usize = 25;
/// Threads writing the tree; the machine is shared.
const WRITERS: usize = 4;

/// The literal that appears in only a handful of files.
pub const RARE: &str = "zebra_quartz_needle";

/// A tree ready to search.
pub struct SearchTree {
    pub root: PathBuf,
    pub files: usize,
    pub bytes: u64,
    _lock: fs::File,
}

/// Make sure the tree of `files` files exists at `dir`, generating it when needed.
pub fn ensure(
    dir: &Path,
    files: usize,
    regenerate: bool,
) -> Result<SearchTree, Box<dyn std::error::Error>> {
    if files < 1000 {
        return Err("the search bench needs at least 1000 files".into());
    }
    if fs::symlink_metadata(dir).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(format!("{} is a symlink", dir.display()).into());
    }
    fs::create_dir_all(dir)?;
    let owned = owned(dir)?;
    let foreign = fs::read_dir(dir)?
        .filter_map(Result::ok)
        .any(|entry| entry.file_name() != LOCK);
    if foreign && !owned {
        return Err(format!(
            "{} is not empty and was not created by this bench; pick another --dir",
            dir.display()
        )
        .into());
    }
    let lock = lock(dir)?;
    let wanted = marker_text(files);
    let current = fs::read_to_string(dir.join(MARKER)).ok();
    if !regenerate
        && let Some(text) = current.as_deref()
        && let Some(bytes) = text.strip_prefix(wanted.as_str())
    {
        let bytes = bytes.trim().strip_prefix("bytes=").unwrap_or("0").parse()?;
        return Ok(SearchTree {
            root: dir.canonicalize()?,
            files,
            bytes,
            _lock: lock,
        });
    }
    if owned {
        remove_generated(dir)?;
    } else {
        use std::io::Write as _;
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dir.join(OWNER))?
            .write_all(OWNER_TEXT.as_bytes())?;
    }
    let started = Instant::now();
    println!("generating {files} files at {}", dir.display());
    let bytes = generate(dir, files)?;
    fs::write(dir.join(MARKER), format!("{wanted}bytes={bytes}\n"))?;
    println!(
        "generated {:.0} MB in {:.1} s",
        bytes as f64 / 1e6,
        started.elapsed().as_secs_f64()
    );
    Ok(SearchTree {
        root: dir.canonicalize()?,
        files,
        bytes,
        _lock: lock,
    })
}

/// Whether the folder carries the bench's ownership marker: false when there is none, an error
/// when something else holds that name (a link, a folder, a file with other text).
fn owned(dir: &Path) -> Result<bool, Box<dyn std::error::Error>> {
    let path = dir.join(OWNER);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_file() && fs::read_to_string(&path)? == OWNER_TEXT {
        return Ok(true);
    }
    Err(format!(
        "{} is not this bench's ownership marker; pick another --dir",
        path.display()
    )
    .into())
}

/// Removes what [`generate`] wrote, and only that. A link in one of those places is removed as a
/// link, never followed.
fn remove_generated(dir: &Path) -> io::Result<()> {
    for name in GENERATED {
        let path = dir.join(name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_dir() => fs::remove_dir_all(&path)?,
            Ok(_) => fs::remove_file(&path)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn marker_text(files: usize) -> String {
    format!("version={VERSION}\nfiles={files}\n")
}

fn lock(dir: &Path) -> Result<fs::File, Box<dyn std::error::Error>> {
    if let Ok(metadata) = fs::symlink_metadata(dir.join(LOCK))
        && !metadata.file_type().is_file()
    {
        return Err(format!("{} is not a regular file", dir.join(LOCK).display()).into());
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join(LOCK))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(fs::TryLockError::WouldBlock) => {
            Err(format!("another run holds {}", dir.join(LOCK).display()).into())
        }
        Err(fs::TryLockError::Error(error)) => Err(error.into()),
    }
}

/// Writes every file on [`WRITERS`] threads and returns the bytes written.
fn generate(dir: &Path, files: usize) -> io::Result<u64> {
    fs::write(
        dir.join(".gitignore"),
        "node_modules/\ndist/\n*.log\n.ace-search-bench-*\n",
    )?;
    fs::create_dir_all(dir.join(".git/info"))?;
    fs::write(dir.join(".git/HEAD"), "ref: refs/heads/main\n")?;
    fs::write(dir.join(".git/info/exclude"), "*.tmp\n")?;
    let results: Vec<io::Result<u64>> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..WRITERS)
            .map(|writer| {
                scope.spawn(move || {
                    let mut bytes = 0;
                    for number in (writer..files).step_by(WRITERS) {
                        bytes += write_file(dir, number)?;
                    }
                    Ok(bytes)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .unwrap_or_else(|_| Err(io::Error::other("a writer panicked")))
            })
            .collect()
    });
    results.into_iter().sum()
}

/// What kind of file number `number` is, and its position among files of that kind.
fn kind(number: usize) -> (Kind, usize) {
    let block = number / 1000;
    let slot = number % 1000;
    let (kind, start, width) = match slot {
        0..200 => (Kind::Node, 0, 200),
        200..220 => (Kind::Binary, 200, 20),
        220..230 => (Kind::Dist, 220, 10),
        230..235 => (Kind::Minified, 230, 5),
        _ => (Kind::Source, 235, 765),
    };
    (kind, block * width + slot - start)
}

#[derive(Clone, Copy)]
enum Kind {
    Node,
    Binary,
    Dist,
    Minified,
    Source,
}

fn write_file(dir: &Path, number: usize) -> io::Result<u64> {
    let (kind, index) = kind(number);
    let folder = index / PER_FOLDER;
    let mut rng = Rng::new(number as u64);
    let (path, bytes) = match kind {
        Kind::Node => (format!("node_modules/pkg_{folder}/lib/f_{index}.js"), {
            let size = 200 + rng_below(&mut rng, 3000);
            text(&mut rng, size, false)
        }),
        Kind::Binary => (
            format!("assets/b{:03}/blob_{index}.bin", folder),
            binary(&mut rng),
        ),
        Kind::Dist => (format!("dist/d{folder:03}/out_{index}.js"), {
            let size = 1000 + rng_below(&mut rng, 8000);
            text(&mut rng, size, false)
        }),
        Kind::Minified => (format!("web/min/m{folder:03}/bundle_{index}.min.js"), {
            let size = 50_000 + rng_below(&mut rng, 150_000);
            minified(&mut rng, size)
        }),
        Kind::Source => {
            let extension = ["rs", "ts", "py", "go", "md"][index % 5];
            let path = format!(
                "src/c{:02}/m{}/g{:03}/file_{index}.{extension}",
                folder % 64,
                (folder / 64) % 8,
                folder / 512
            );
            let size = source_size(&mut rng);
            let rare = index % 19_997 == 11;
            (path, text(&mut rng, size, rare))
        }
    };
    let path = dir.join(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, &bytes)?;
    Ok(bytes.len() as u64)
}

/// Mostly small files, some medium, a few large.
fn source_size(rng: &mut Rng) -> usize {
    match rng_below(rng, 1000) {
        0..700 => 300 + rng_below(rng, 2_700),
        700..950 => 3_000 + rng_below(rng, 13_000),
        950..997 => 16_000 + rng_below(rng, 80_000),
        _ => 96_000 + rng_below(rng, 900_000),
    }
}

const WORDS: [&str; 64] = [
    "index", "value", "config", "buffer", "handler", "result", "state", "query", "cache", "stream",
    "token", "parser", "writer", "reader", "socket", "server", "client", "worker", "record",
    "entry", "folder", "path", "match", "search", "render", "layout", "event", "frame", "batch",
    "limit", "cursor", "offset", "length", "count", "error", "input", "output", "session",
    "thread", "agent", "model", "prompt", "schema", "field", "column", "table", "store", "queue",
    "timer", "clock", "signal", "channel", "packet", "message", "header", "payload", "encode",
    "decode", "load", "save", "open", "close", "start", "stop",
];

/// Source-like lines up to `size` bytes; `rare` adds the rare literal once.
fn text(rng: &mut Rng, size: usize, rare: bool) -> Vec<u8> {
    let mut out = String::with_capacity(size + 128);
    out.push_str("// SPDX-License-Identifier: Apache-2.0\n");
    let mut rare_at = if rare { size / 2 } else { usize::MAX };
    while out.len() < size {
        if out.len() >= rare_at {
            out.push_str(&format!("    let marker = \"{RARE}\";\n"));
            rare_at = usize::MAX;
            continue;
        }
        line(rng, &mut out);
    }
    out.into_bytes()
}

fn line(rng: &mut Rng, out: &mut String) {
    let a = word(rng);
    let b = word(rng);
    let c = word(rng);
    let d = word(rng);
    let n = rng_below(rng, 1000);
    let line = match rng_below(rng, 10) {
        0 => format!("    let {a}_{b} = {c}({d}, {n});\n"),
        1 => format!(
            "fn {a}_{b}({c}: &{}) -> Result<{}, Error> {{\n",
            capital(c),
            capital(d)
        ),
        2 => format!("    // the {a} keeps the {b} until the {c} is ready for the {d}\n"),
        3 => format!("    if {a}.{b} > {n} {{ return {c}; }}\n"),
        4 => format!(
            "import {{ {}{} }} from \"./{a}/{b}\";\n",
            capital(c),
            capital(d)
        ),
        5 => format!("    {a}.{b}({c}, \"{d}\");\n"),
        6 => "}\n".to_owned(),
        7 => format!(
            "    const {}Handler = new {}Store({a}, {b});\n",
            capital(c),
            capital(d)
        ),
        8 => "\n".to_owned(),
        _ => format!("    return {a}_{b};\n"),
    };
    out.push_str(&line);
}

/// One line of `size` bytes, as a bundler writes it.
fn minified(rng: &mut Rng, size: usize) -> Vec<u8> {
    let mut out = String::with_capacity(size + 64);
    while out.len() < size {
        let (a, b, c) = (word(rng), word(rng), word(rng));
        out.push_str(&format!("var {a}={b}.{c}({});", rng_below(rng, 100)));
    }
    out.push('\n');
    out.into_bytes()
}

/// A NUL early, then a mix of text and noise.
fn binary(rng: &mut Rng) -> Vec<u8> {
    let size = 1_000 + rng_below(rng, 64_000);
    let mut out = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR config handler".to_vec();
    while out.len() < size {
        out.extend_from_slice(&rng.next().to_le_bytes());
    }
    out
}

fn word(rng: &mut Rng) -> &'static str {
    WORDS[rng_below(rng, WORDS.len())]
}

fn capital(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
        None => String::new(),
    }
}

fn rng_below(rng: &mut Rng, bound: usize) -> usize {
    (rng.next() % bound as u64) as usize
}

/// xorshift64*, seeded per file, so the tree depends on nothing but the file count.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
}
