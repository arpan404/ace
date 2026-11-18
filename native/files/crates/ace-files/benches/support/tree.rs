// SPDX-License-Identifier: Apache-2.0

//! Generates the checkout the bench measures, and reuses it when it is already there.
//!
//! The tree is a monorepo shape: `crates/<crate>/src/<module>/group_NN/` folders holding twenty
//! source files each, one folder of twenty thousand files under `apps/web/public/bulk`, and a
//! gitignored `node_modules` of JavaScript packages. Source files carry about two gigabytes of
//! content in total at a million files, which is the budget the content search is measured over.
//!
//! Generation is deterministic: the same `--files` value produces the same paths, so the marker
//! file written last means a complete tree that can be reused as-is.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// Records what was generated. Written last, so its presence means the tree is complete.
pub const MARKER: &str = ".ace-bench-tree";

/// The tree's layout version, so a change to the generator does not reuse an old tree.
const VERSION: &str = "2";

/// Files per leaf folder.
const PER_LEAF: usize = 20;

/// JavaScript files per installed package folder.
const NODE_PER_PACKAGE: usize = 20;

/// The content the search is measured over, spread across the source files.
const CONTENT_BUDGET: usize = 2 * 1024 * 1024 * 1024;

/// The largest content one source file carries, so a small tree stays quick to write.
const MAX_SOURCE_BYTES: usize = 8 * 1024;

/// The smallest content one source file carries, so a huge tree still reads real bytes.
const MIN_SOURCE_BYTES: usize = 128;

/// How many threads write the tree. This Mac is shared and heavily loaded.
const WRITERS: usize = 4;

/// The tree's shape, derived from the file count alone.
pub struct Shape {
    /// Files generated, not counting the marker and git files.
    pub files: usize,
    /// Files inside the gitignored `node_modules` tree.
    pub node_files: usize,
    /// Files in the one big folder.
    pub big_files: usize,
    /// Searchable source files.
    pub source_files: usize,
    /// Source files per leaf folder before the remainder is spread over the first folders.
    pub per_leaf: usize,
    /// Leaf folders holding one file more than `per_leaf`.
    pub fuller_leaves: usize,
    /// Leaf folders under `crates/`.
    pub leaves: usize,
    /// Crate folders.
    pub crates: usize,
    /// Module folders per crate.
    pub modules: usize,
    /// Installed packages under `node_modules`.
    pub packages: usize,
    /// Content bytes one source file carries.
    pub source_bytes: usize,
}

impl Shape {
    /// The tree's shape for `files` files.
    pub fn new(files: usize) -> Shape {
        let node_files = files / 5;
        let visible = files - node_files;
        let big_files = (files / 50).clamp(1, visible.saturating_sub(1).max(1));
        let source_files = visible - big_files;
        let leaves = source_files.div_ceil(PER_LEAF).max(1);
        let per_leaf = source_files / leaves;
        let fuller_leaves = source_files % leaves;
        let crates = (leaves / 130).clamp(1, 600);
        let modules = 6;
        let packages = node_files.div_ceil(NODE_PER_PACKAGE);
        let source_bytes =
            (CONTENT_BUDGET / source_files.max(1)).clamp(MIN_SOURCE_BYTES, MAX_SOURCE_BYTES);
        Shape {
            files,
            node_files,
            big_files,
            source_files,
            per_leaf,
            fuller_leaves,
            leaves,
            crates,
            modules,
            packages,
            source_bytes,
        }
    }

    /// Folders the tree holds, the root included.
    pub fn folders(&self) -> usize {
        let crate_dirs = self.crates;
        let src_dirs = self.crates;
        let module_dirs = self.leaves.min(self.crates * self.modules);
        1 + 1
            + crate_dirs
            + src_dirs
            + module_dirs
            + self.leaves
            + 4
            + (1 + self.packages + self.packages)
            + 2
    }

    /// The folder of twenty thousand files.
    pub fn big_dir(&self) -> &'static str {
        "apps/web/public/bulk"
    }

    /// Files in leaf folder `leaf`.
    fn leaf_files(&self, leaf: usize) -> usize {
        self.per_leaf + usize::from(leaf < self.fuller_leaves)
    }

    /// Files in leaf folders `0..leaf`, so a worker knows its first global file number.
    fn files_before_leaf(&self, leaf: usize) -> usize {
        let full = leaf.min(self.fuller_leaves);
        leaf * self.per_leaf + full
    }

    /// Leaf folder `leaf`'s root-relative folder.
    fn leaf_dir(&self, leaf: usize) -> String {
        let krate = leaf % self.crates;
        let module = (leaf / self.crates) % self.modules;
        let group = leaf / (self.crates * self.modules);
        format!(
            "crates/{}/src/{}/group_{group:02}",
            crate_name(krate),
            module_name(module)
        )
    }
}

/// A tree that is ready to measure.
pub struct Tree {
    /// The checkout's absolute path.
    pub root: PathBuf,
    /// What is in it.
    pub shape: Shape,
    /// Content bytes written, as the marker recorded them.
    pub bytes: u64,
    /// True when this run generated the tree rather than reusing it.
    pub generated: bool,
}

/// Make sure the tree exists, generating it when the marker says a different tree is there.
pub fn ensure(
    dir: &Path,
    files: usize,
    regenerate: bool,
) -> Result<Tree, Box<dyn std::error::Error>> {
    let shape = Shape::new(files);
    let root = dir.to_path_buf();
    if !regenerate
        && let Some(marker) = read_marker(dir)?
        && marker.files == files
        && marker.version == VERSION
    {
        return Ok(Tree {
            root,
            shape,
            bytes: marker.bytes,
            generated: false,
        });
    }
    if dir.exists() && !regenerate {
        let empty = fs::read_dir(dir)?.next().is_none();
        if !empty {
            return Err(format!(
                "{} holds a tree this run did not generate; pass --regenerate to replace it",
                dir.display()
            )
            .into());
        }
    }
    if dir.exists() {
        fs::remove_dir_all(dir)?;
    }
    fs::create_dir_all(dir)?;
    let started = Instant::now();
    println!(
        "generating {} files ({} folders) at {}: {} source files of {} bytes, {} node_modules files, {} in one folder",
        shape.files,
        shape.folders(),
        dir.display(),
        shape.source_files,
        shape.source_bytes,
        shape.node_files,
        shape.big_files,
    );
    let bytes = generate(dir, &shape)?;
    write_marker(dir, &shape, bytes)?;
    println!("generated in {:.1} s", started.elapsed().as_secs_f64());
    Ok(Tree {
        root,
        shape,
        bytes,
        generated: true,
    })
}

/// Write every folder and file, spreading the work over a few threads.
fn generate(dir: &Path, shape: &Shape) -> io::Result<u64> {
    let written = AtomicUsize::new(0);
    let done = AtomicBool::new(false);
    let mut bytes = 0u64;
    std::thread::scope(|scope| {
        scope.spawn(|| {
            while !done.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_secs(2));
                let count = written.load(Ordering::Relaxed);
                if count < shape.files {
                    eprintln!("  ... {count} of {} files", shape.files);
                }
            }
        });
        let chunks = partition(shape, WRITERS);
        let mut handles = Vec::with_capacity(chunks.len());
        for chunk in chunks {
            let written = &written;
            handles.push(scope.spawn(move || write_chunk(dir, shape, &chunk, written)));
        }
        let mut failure = None;
        for handle in handles {
            match handle.join() {
                Ok(Ok(count)) => bytes += count,
                Ok(Err(error)) => {
                    if failure.is_none() {
                        failure = Some(error);
                    }
                }
                Err(_) => {
                    if failure.is_none() {
                        failure = Some(io::Error::other("a tree writer panicked"));
                    }
                }
            }
        }
        done.store(true, Ordering::Relaxed);
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    })?;
    write_control_files(dir)?;
    Ok(bytes)
}

/// One worker's share of the tree.
struct Chunk {
    leaves: std::ops::Range<usize>,
    packages: std::ops::Range<usize>,
    big: bool,
}

/// Split the leaves and packages between the writers, giving the last chunk the big folder.
fn partition(shape: &Shape, writers: usize) -> Vec<Chunk> {
    let writers = writers.max(1);
    let mut chunks = Vec::with_capacity(writers);
    for writer in 0..writers {
        let leaves = split(shape.leaves, writer, writers);
        let packages = split(shape.packages, writer, writers);
        chunks.push(Chunk {
            leaves,
            packages,
            big: writer == 0,
        });
    }
    chunks
}

/// `total` items split into `parts` contiguous ranges, the given one.
fn split(total: usize, part: usize, parts: usize) -> std::ops::Range<usize> {
    let start = total * part / parts;
    let end = total * (part + 1) / parts;
    start..end
}

/// Write one worker's leaves, packages and, for the first worker, the big folder.
fn write_chunk(dir: &Path, shape: &Shape, chunk: &Chunk, written: &AtomicUsize) -> io::Result<u64> {
    let mut bytes = 0u64;
    for leaf in chunk.leaves.clone() {
        let folder = dir.join(shape.leaf_dir(leaf));
        fs::create_dir_all(&folder)?;
        let count = shape.leaf_files(leaf);
        for (global, file) in (shape.files_before_leaf(leaf)..).zip(0..count) {
            let name = file_name(leaf + file, file, count);
            let contents = source_text(global, shape.source_bytes, global.is_multiple_of(50));
            fs::write(folder.join(name), &contents)?;
            bytes += contents.len() as u64;
            written.fetch_add(1, Ordering::Relaxed);
        }
    }
    for package in chunk.packages.clone() {
        let folder = dir.join(format!("node_modules/pkg_{package:05}/lib"));
        fs::create_dir_all(&folder)?;
        for file in 0..NODE_PER_PACKAGE {
            let contents = node_text(package, file);
            fs::write(folder.join(format!("module_{file:02}.js")), &contents)?;
            bytes += contents.len() as u64;
            written.fetch_add(1, Ordering::Relaxed);
        }
    }
    if chunk.big {
        let folder = dir.join(shape.big_dir());
        fs::create_dir_all(&folder)?;
        for file in 0..shape.big_files {
            let contents = big_text(file);
            fs::write(folder.join(format!("asset_{file:05}.txt")), &contents)?;
            bytes += contents.len() as u64;
            written.fetch_add(1, Ordering::Relaxed);
        }
    }
    Ok(bytes)
}

/// The files that make the tree a checkout: ignore rules and a git repository's marker files.
fn write_control_files(dir: &Path) -> io::Result<()> {
    fs::write(
        dir.join(".gitignore"),
        "node_modules/\ntarget/\n*.log\n.ace-bench-tree\n",
    )?;
    fs::write(
        dir.join("README.md"),
        "# ace files bench checkout\n\nGenerated by `cargo bench -p ace-files --bench checkout`.\n",
    )?;
    fs::create_dir_all(dir.join(".git/info"))?;
    fs::write(dir.join(".git/HEAD"), "ref: refs/heads/main\n")?;
    fs::write(
        dir.join(".git/config"),
        "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfilemode = true\n",
    )?;
    fs::write(dir.join(".git/info/exclude"), "*.log\n")?;
    Ok(())
}

/// Write the marker that makes the next run reuse this tree.
fn write_marker(dir: &Path, shape: &Shape, bytes: u64) -> io::Result<()> {
    fs::write(
        dir.join(MARKER),
        format!(
            "version={VERSION}\nfiles={}\nfolders={}\nbytes={bytes}\n",
            shape.files,
            shape.folders()
        ),
    )
}

/// What an earlier run recorded about the tree.
struct Marker {
    version: String,
    files: usize,
    bytes: u64,
}

fn read_marker(dir: &Path) -> io::Result<Option<Marker>> {
    let text = match fs::read_to_string(dir.join(MARKER)) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut marker = Marker {
        version: String::new(),
        files: 0,
        bytes: 0,
    };
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key {
            "version" => marker.version = value.to_owned(),
            "files" => marker.files = value.parse().unwrap_or(0),
            "bytes" => marker.bytes = value.parse().unwrap_or(0),
            _ => {}
        }
    }
    Ok(Some(marker))
}

const NAMES: [&str; 20] = [
    "main", "lib", "mod", "index", "state", "query", "walk", "apply", "render", "socket",
    "history", "models", "views", "util", "error", "config", "types", "server", "client", "worker",
];

const MODULES: [&str; 6] = ["main", "index", "walk", "render", "socket", "types"];

/// Crate folder names, so quick-open queries read like the ones a person types.
const CRATES: [&str; 12] = [
    "ace", "files", "srvmain", "editor", "protocol", "daemon", "index", "watch", "search", "io",
    "wire", "cli",
];

fn module_name(module: usize) -> &'static str {
    MODULES[module % MODULES.len()]
}

fn crate_name(krate: usize) -> String {
    format!("{}_{krate:03}", CRATES[krate % CRATES.len()])
}

/// A distinct file name inside one folder, the first ones being the plain module names.
fn file_name(seed: usize, file: usize, count: usize) -> String {
    let name = NAMES[seed % NAMES.len()];
    let extension = if seed.is_multiple_of(7) { "ts" } else { "rs" };
    if count > NAMES.len() && file >= NAMES.len() {
        format!("{name}_{file}.{extension}")
    } else {
        format!("{name}.{extension}")
    }
}

/// Source-like text of `size` bytes, with the search's literal in roughly every fiftieth file.
fn source_text(index: usize, size: usize, marked: bool) -> Vec<u8> {
    let mut text = String::with_capacity(size + 256);
    text.push_str("// SPDX-License-Identifier: Apache-2.0\n");
    text.push_str(&format!(
        "// fixture file {index} for the ace-files checkout bench\n\n"
    ));
    if marked {
        text.push_str("pub const BENCH_SEARCH_TARGET: &str = \"bench_search_marker_token\";\n");
    }
    while text.len() < size {
        text.push_str(
            "    let value = compute(index, input);\n    if value > threshold {\n        record(index, value);\n    }\n",
        );
    }
    text.into_bytes()
}

/// A small installed-package file.
fn node_text(package: usize, file: usize) -> Vec<u8> {
    format!(
        "\"use strict\";\n// node_modules fixture {package}/{file}\nconst helper = require(\"./helper\");\n\nmodule.exports = function run(input) {{\n  return helper(input, {file});\n}};\n"
    )
    .into_bytes()
}

/// A small asset file, one of twenty thousand in one folder.
fn big_text(file: usize) -> Vec<u8> {
    format!(
        "asset {file}\nname: logo_{file}.svg\nvariants: light dark\n\n{{\"file\":{file},\"scale\":1}}\n"
    )
    .into_bytes()
}
