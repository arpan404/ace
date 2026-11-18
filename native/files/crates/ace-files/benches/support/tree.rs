// SPDX-License-Identifier: Apache-2.0

//! Generates the checkout the bench measures, and reuses it when it is already there.
//!
//! The tree is a monorepo shape: `crates/<crate>/src/<module>/group_NN/` folders holding twenty
//! source files each, one folder of files under `apps/web/public/bulk`, and a gitignored
//! `node_modules` of JavaScript packages. Source files carry about two gigabytes of content in
//! total at a million files, which is the budget the content search is measured over.
//!
//! The tree is the bench's own folder. The first run writes an ownership marker before it writes
//! anything else, and every later run — `--regenerate` included — refuses to empty a folder that
//! does not carry it, so a mistyped `--dir` cannot delete a checkout. Generation is deterministic:
//! the same `--files` value produces the same paths and the same inventory. The completion marker
//! is written last and atomically, and reuse checks that the tree still holds the inventory that
//! marker recorded.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::content::{big_text, crate_name, file_name, module_name, node_text, source_text};

/// Records that this bench created the folder, written before any tree goes into it. A folder is
/// emptied only when this file says the bench owns it.
pub const OWNER: &str = ".ace-bench-owned";

/// Records what was generated. Written last and atomically, so its presence means a complete tree.
pub const MARKER: &str = ".ace-bench-tree";

/// What the ownership marker holds. A folder holding a different file of this name is not ours.
const OWNER_TEXT: &str = "ace-files checkout bench folder\n";

/// The tree's layout version, so a change to the generator does not reuse an old tree.
const VERSION: &str = "3";

/// Files per leaf folder.
const PER_LEAF: usize = 20;

/// JavaScript files per installed package folder, the last package holding the remainder.
const NODE_PER_PACKAGE: usize = 20;

/// The content the search is measured over, spread across the source files.
const CONTENT_BUDGET: usize = 2 * 1024 * 1024 * 1024;

/// The largest content one source file carries, so a small tree stays quick to write.
const MAX_SOURCE_BYTES: usize = 8 * 1024;

/// The smallest content one source file carries, so a huge tree still reads real bytes.
const MIN_SOURCE_BYTES: usize = 128;

/// How many threads write the tree. This Mac is shared and heavily loaded.
const WRITERS: usize = 4;

/// Leaf folders whose file inventory is checked one by one when a tree is reused. Every leaf is
/// checked for existence; walking every file of every leaf would cost more than it protects.
const LEAF_SAMPLES: usize = 16;

/// Packages whose file inventory is checked one by one when a tree is reused.
const PACKAGE_SAMPLES: usize = 8;

/// The tree's shape, derived from the file count alone.
#[derive(Clone, PartialEq, Eq)]
pub struct Shape {
    /// Files generated, not counting the markers and git files.
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
    /// The tree's shape for `files` files. Zero files is refused: there is nothing to measure.
    pub fn new(files: usize) -> Result<Shape, String> {
        if files == 0 {
            return Err("the bench needs at least one file".to_owned());
        }
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
        Ok(Shape {
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
        })
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

    /// The folder of files that holds the most in one place.
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

    /// Files in installed package `package`: twenty, except the last, which holds what is left of
    /// `node_files`, so the tree writes exactly the file count it was asked for.
    fn package_files(&self, package: usize) -> usize {
        let start = package * NODE_PER_PACKAGE;
        self.node_files.saturating_sub(start).min(NODE_PER_PACKAGE)
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
    /// When the tree's files were last written, so the report can say how warm the cache is.
    pub completed: Option<SystemTime>,
}

/// Make sure the tree exists, generating it when the marker does not describe it.
pub fn ensure(
    dir: &Path,
    files: usize,
    regenerate: bool,
) -> Result<Tree, Box<dyn std::error::Error>> {
    let shape = Shape::new(files)?;
    reject_symlinks(dir)?;
    let root = dir.to_path_buf();
    if !regenerate
        && let Some(marker) = read_marker(dir)?
        && marker.matches(&shape)
    {
        validate_inventory(dir, &shape)?;
        // A tree whose completion marker is ours is ours: claim it, so a later `--regenerate`
        // may replace it. Older trees were written before the ownership marker existed.
        own(dir)?;
        return Ok(Tree {
            root,
            shape,
            bytes: marker.bytes,
            generated: false,
            completed: Some(marker.completed),
        });
    }
    claim(dir)?;
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
    let completed = SystemTime::now();
    write_marker(dir, &shape, bytes, completed)?;
    println!("generated in {:.1} s", started.elapsed().as_secs_f64());
    Ok(Tree {
        root,
        shape,
        bytes,
        generated: true,
        completed: Some(completed),
    })
}

/// Refuse a bench folder reached through a symlink of its own, and a path holding `..`.
///
/// The folder's existing ancestors are resolved rather than refused: macOS's `/var` is itself a
/// symlink to `/private/var`, and the bench never removes an ancestor, only the folder it names.
fn reject_symlinks(dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if dir.as_os_str().is_empty() {
        return Err("--dir needs a path".into());
    }
    if dir
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!(
            "{} contains `..`; pass the folder's real path",
            dir.display()
        )
        .into());
    }
    match fs::symlink_metadata(dir) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "{} is a symlink; the bench needs a real folder it can own",
            dir.display()
        )
        .into()),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("cannot inspect {}: {error}", dir.display()).into()),
    }
}

/// Make `dir` an empty folder this bench owns, refusing a folder it did not create.
fn claim(dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    match fs::symlink_metadata(dir) {
        Ok(metadata) if !metadata.is_dir() => {
            return Err(format!("{} is not a folder", dir.display()).into());
        }
        Ok(_) => {
            let empty = fs::read_dir(dir)?.next().is_none();
            if !empty {
                let owner = fs::read_to_string(dir.join(OWNER)).unwrap_or_default();
                if owner != OWNER_TEXT {
                    return Err(format!(
                        "{} holds files this bench did not create; pass a dedicated --dir for the bench, or empty it yourself",
                        dir.display()
                    )
                    .into());
                }
                // Only ever a folder the ownership marker says is the bench's own.
                fs::remove_dir_all(dir)?;
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("cannot inspect {}: {error}", dir.display()).into()),
    }
    fs::create_dir_all(dir)?;
    own(dir)?;
    Ok(())
}

/// Write the ownership marker, unless the folder already carries it.
fn own(dir: &Path) -> io::Result<()> {
    match fs::read_to_string(dir.join(OWNER)) {
        Ok(text) if text == OWNER_TEXT => Ok(()),
        _ => fs::write(dir.join(OWNER), OWNER_TEXT),
    }
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

/// Split the leaves and packages between the writers, giving the first chunk the big folder.
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
        for file in 0..shape.package_files(package) {
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
        "node_modules/\ntarget/\n*.log\n.ace-bench-*\n",
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

/// The keys the completion marker holds, in the order it writes them. A marker missing one,
/// repeating one or carrying a key this build does not know is not this build's marker.
const KEYS: [&str; 9] = [
    "version",
    "files",
    "folders",
    "bytes",
    "source_files",
    "node_files",
    "big_files",
    "source_bytes",
    "completed_ms",
];

/// Write the marker that makes the next run reuse this tree, atomically: a reader never sees a
/// half-written marker, so an interrupted run cannot look complete.
fn write_marker(dir: &Path, shape: &Shape, bytes: u64, completed: SystemTime) -> io::Result<()> {
    let completed_ms = completed
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let text = format!(
        "version={VERSION}\nfiles={}\nfolders={}\nbytes={bytes}\nsource_files={}\nnode_files={}\nbig_files={}\nsource_bytes={}\ncompleted_ms={completed_ms}\n",
        shape.files,
        shape.folders(),
        shape.source_files,
        shape.node_files,
        shape.big_files,
        shape.source_bytes,
    );
    let temp = dir.join(format!("{MARKER}.tmp"));
    fs::write(&temp, text)?;
    fs::rename(&temp, dir.join(MARKER))
}

/// What an earlier run recorded about the tree.
struct Marker {
    files: usize,
    folders: usize,
    bytes: u64,
    source_files: usize,
    node_files: usize,
    big_files: usize,
    source_bytes: usize,
    completed: SystemTime,
}

impl Marker {
    /// True when this marker describes the inventory `shape` asks for.
    fn matches(&self, shape: &Shape) -> bool {
        self.files == shape.files
            && self.folders == shape.folders()
            && self.source_files == shape.source_files
            && self.node_files == shape.node_files
            && self.big_files == shape.big_files
            && self.source_bytes == shape.source_bytes
    }
}

fn read_marker(dir: &Path) -> io::Result<Option<Marker>> {
    let text = match fs::read_to_string(dir.join(MARKER)) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        // A marker that is not UTF-8 is not a marker this build wrote.
        Err(error) if error.kind() == io::ErrorKind::InvalidData => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(parse_marker(&text))
}

/// The marker's numbers, or `None` for anything this build did not write. Strict on purpose: a
/// marker with a missing, repeated or unknown key is regenerated rather than trusted.
fn parse_marker(text: &str) -> Option<Marker> {
    let mut values: HashMap<&str, &str> = HashMap::new();
    for line in text.lines() {
        let (key, value) = line.split_once('=')?;
        if !KEYS.contains(&key) || values.insert(key, value).is_some() {
            return None;
        }
    }
    if values.len() != KEYS.len() || values.get("version").copied() != Some(VERSION) {
        return None;
    }
    Some(Marker {
        files: values.get("files")?.parse().ok()?,
        folders: values.get("folders")?.parse().ok()?,
        bytes: values.get("bytes")?.parse().ok()?,
        source_files: values.get("source_files")?.parse().ok()?,
        node_files: values.get("node_files")?.parse().ok()?,
        big_files: values.get("big_files")?.parse().ok()?,
        source_bytes: values.get("source_bytes")?.parse().ok()?,
        completed: UNIX_EPOCH + Duration::from_millis(values.get("completed_ms")?.parse().ok()?),
    })
}

/// Check that a reused tree still holds the inventory its marker describes: every leaf and package
/// folder exists, the sampled ones hold exactly the files the generator would write, and the one
/// big folder holds all of its entries. A folder emptied behind the bench's back would otherwise
/// measure a tree that is not there.
fn validate_inventory(dir: &Path, shape: &Shape) -> Result<(), Box<dyn std::error::Error>> {
    for path in [".git/HEAD", ".gitignore", "README.md"] {
        require_file(&dir.join(path))?;
    }
    let big = dir.join(shape.big_dir());
    require_dir(&big)?;
    let big_entries = count_entries(&big)?;
    if big_entries != shape.big_files {
        return Err(format!(
            "{} holds {big_entries} entries, not {}",
            big.display(),
            shape.big_files
        )
        .into());
    }
    for leaf in 0..shape.leaves {
        require_dir(&dir.join(shape.leaf_dir(leaf)))?;
    }
    for package in 0..shape.packages {
        require_dir(&package_dir(dir, package))?;
    }
    for leaf in sample(shape.leaves, LEAF_SAMPLES) {
        let folder = dir.join(shape.leaf_dir(leaf));
        let count = shape.leaf_files(leaf);
        let entries = count_entries(&folder)?;
        if entries != count {
            return Err(format!("{} holds {entries} files, not {count}", folder.display()).into());
        }
        let last = file_name(leaf + count - 1, count - 1, count);
        require_file(&folder.join(last))?;
    }
    for package in sample(shape.packages, PACKAGE_SAMPLES) {
        let folder = package_dir(dir, package);
        let count = shape.package_files(package);
        let entries = count_entries(&folder)?;
        if entries != count {
            return Err(format!("{} holds {entries} files, not {count}", folder.display()).into());
        }
        require_file(&folder.join(format!("module_{:02}.js", count - 1)))?;
    }
    Ok(())
}

/// One installed package's library folder.
fn package_dir(dir: &Path, package: usize) -> PathBuf {
    dir.join(format!("node_modules/pkg_{package:05}/lib"))
}

/// Up to `wanted` indices spread over `total`, so a sample covers the whole tree.
fn sample(total: usize, wanted: usize) -> Vec<usize> {
    if total <= wanted {
        return (0..total).collect();
    }
    (0..wanted).map(|index| index * total / wanted).collect()
}

/// How many entries one folder holds.
fn count_entries(dir: &Path) -> io::Result<usize> {
    let mut count = 0;
    for entry in fs::read_dir(dir)? {
        entry?;
        count += 1;
    }
    Ok(count)
}

/// A folder the tree should hold: a real folder, never a symlink pointing somewhere else.
fn require_dir(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("{} is missing: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{} is not a real folder", path.display()).into());
    }
    Ok(())
}

/// A file the tree should hold: a real file, never a symlink pointing somewhere else.
fn require_file(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("{} is missing: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{} is not a real file", path.display()).into());
    }
    Ok(())
}
