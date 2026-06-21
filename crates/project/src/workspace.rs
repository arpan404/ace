use crate::{
    ProjectError, Result,
    constants::{
        FAVICON_CANDIDATES, ICON_SOURCE_FILES, PROJECT_READ_FILE_MAX_BYTES,
        PROJECT_SEARCH_ENTRIES_MAX_LIMIT, READ_FILE_CACHE_MAX_ENTRIES, WORKSPACE_INDEX_MAX_ENTRIES,
    },
    icons::{extract_icon_href, icon_href_candidates, is_file_within_root},
    models::{
        ProjectCreateEntryResult, ProjectDeleteEntryResult, ProjectEntriesResult, ProjectEntry,
        ProjectEntryKind, ProjectFaviconResult, ProjectReadFileResult, ProjectRenameEntryResult,
        ProjectWriteFileResult, ReadCacheEntry, ResolvedPath, WorkspaceIndex,
    },
    path_utils::{expand_home, file_fingerprint, parent_path, sha256_hex, to_posix},
    search::{normalize_query, score_entry, should_ignore_name},
};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Debug, Default)]
pub struct WorkspaceService {
    index_cache: HashMap<PathBuf, WorkspaceIndex>,
    read_cache: HashMap<PathBuf, ReadCacheEntry>,
    read_cache_order: VecDeque<PathBuf>,
}

impl WorkspaceService {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn normalize_workspace_root(
        workspace_root: impl AsRef<Path>,
        create_if_missing: bool,
    ) -> Result<PathBuf> {
        let path = expand_home(workspace_root.as_ref())
            .canonicalize()
            .or_else(|error| {
                if create_if_missing {
                    fs::create_dir_all(expand_home(workspace_root.as_ref()))?;
                    expand_home(workspace_root.as_ref()).canonicalize()
                } else {
                    Err(error)
                }
            })?;
        if !path.exists() {
            return Err(ProjectError::WorkspaceMissing(path));
        }
        if !path.is_dir() {
            return Err(ProjectError::WorkspaceNotDirectory(path));
        }
        Ok(path)
    }

    pub fn resolve_relative_path_within_root(
        workspace_root: impl AsRef<Path>,
        relative_path: &str,
    ) -> Result<ResolvedPath> {
        let root = Self::normalize_workspace_root(workspace_root, false)?;
        let trimmed = relative_path.trim();
        let candidate = Path::new(trimmed);
        if candidate.is_absolute() || trimmed.is_empty() {
            return Err(ProjectError::PathOutsideRoot);
        }
        if candidate
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::RootDir))
        {
            return Err(ProjectError::PathOutsideRoot);
        }
        let absolute_path = root.join(candidate);
        let relative = absolute_path
            .strip_prefix(&root)
            .map_err(|_| ProjectError::PathOutsideRoot)?;
        let relative_path = to_posix(relative);
        if relative_path.is_empty() {
            return Err(ProjectError::PathOutsideRoot);
        }
        Ok(ResolvedPath {
            absolute_path,
            relative_path,
        })
    }

    pub fn invalidate(&mut self, cwd: impl AsRef<Path>) {
        let path = expand_home(cwd.as_ref());
        self.index_cache.remove(&path);
        if let Ok(canonical) = path.canonicalize() {
            self.index_cache.remove(&canonical);
        }
    }

    pub fn list_tree(&mut self, cwd: impl AsRef<Path>) -> Result<ProjectEntriesResult> {
        let root = Self::normalize_workspace_root(cwd, false)?;
        let index = self.index_for(&root)?;
        Ok(ProjectEntriesResult {
            entries: index.entries.clone(),
            truncated: index.truncated,
        })
    }

    pub fn search_entries(
        &mut self,
        cwd: impl AsRef<Path>,
        query: &str,
        limit: usize,
    ) -> Result<ProjectEntriesResult> {
        let limit = limit.min(PROJECT_SEARCH_ENTRIES_MAX_LIMIT);
        let normalized_query = normalize_query(query);
        let root = Self::normalize_workspace_root(cwd, false)?;
        let index = self.index_for(&root)?;
        let mut ranked = Vec::new();
        for entry in &index.entries {
            if let Some(score) = score_entry(entry, &normalized_query) {
                ranked.push((score, entry.clone()));
            }
        }
        ranked.sort_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.path.cmp(&right.1.path))
        });
        Ok(ProjectEntriesResult {
            truncated: index.truncated || ranked.len() > limit,
            entries: ranked
                .into_iter()
                .take(limit)
                .map(|(_, entry)| entry)
                .collect(),
        })
    }

    pub fn create_entry(
        &mut self,
        cwd: impl AsRef<Path>,
        relative_path: &str,
        kind: ProjectEntryKind,
    ) -> Result<ProjectCreateEntryResult> {
        let target = Self::resolve_relative_path_within_root(&cwd, relative_path)?;
        if target.absolute_path.exists() {
            return Err(ProjectError::EntryAlreadyExists(target.relative_path));
        }
        if let Some(parent) = target.absolute_path.parent() {
            fs::create_dir_all(parent)?;
        }
        match kind {
            ProjectEntryKind::Directory => fs::create_dir_all(&target.absolute_path)?,
            ProjectEntryKind::File => fs::write(&target.absolute_path, b"")?,
        }
        self.invalidate(cwd);
        Ok(ProjectCreateEntryResult {
            kind,
            relative_path: target.relative_path,
        })
    }

    pub fn delete_entry(
        &mut self,
        cwd: impl AsRef<Path>,
        relative_path: &str,
    ) -> Result<ProjectDeleteEntryResult> {
        let target = Self::resolve_relative_path_within_root(&cwd, relative_path)?;
        if !target.absolute_path.exists() {
            return Err(ProjectError::EntryMissing(target.relative_path));
        }
        if target.absolute_path.is_dir() {
            fs::remove_dir_all(&target.absolute_path)?;
        } else {
            fs::remove_file(&target.absolute_path)?;
        }
        self.read_cache
            .retain(|path, _| !path.starts_with(&target.absolute_path));
        self.invalidate(cwd);
        Ok(ProjectDeleteEntryResult {
            relative_path: target.relative_path,
        })
    }

    pub fn read_file(
        &mut self,
        cwd: impl AsRef<Path>,
        relative_path: &str,
    ) -> Result<ProjectReadFileResult> {
        let target = Self::resolve_relative_path_within_root(cwd, relative_path)?;
        let metadata = fs::metadata(&target.absolute_path)?;
        if !metadata.is_file() {
            return Err(ProjectError::UnsupportedFile);
        }
        if metadata.len() > PROJECT_READ_FILE_MAX_BYTES {
            return Err(ProjectError::FileTooLarge);
        }
        let fingerprint = file_fingerprint(&metadata);
        if let Some(entry) = self.read_cache.get(&target.absolute_path)
            && entry.fingerprint == fingerprint
        {
            return Ok(entry.result.clone());
        }
        let bytes = fs::read(&target.absolute_path)?;
        if bytes.contains(&0) {
            return Err(ProjectError::UnsupportedFile);
        }
        let contents =
            String::from_utf8(bytes.clone()).map_err(|_| ProjectError::UnsupportedFile)?;
        let result = ProjectReadFileResult {
            relative_path: target.relative_path,
            size_bytes: bytes.len() as u64,
            version: sha256_hex(&bytes),
            contents,
        };
        self.cache_read(target.absolute_path, fingerprint, result.clone());
        Ok(result)
    }

    pub fn write_file(
        &mut self,
        cwd: impl AsRef<Path>,
        relative_path: &str,
        contents: &str,
        expected_version: Option<&str>,
        overwrite: bool,
    ) -> Result<ProjectWriteFileResult> {
        let target = Self::resolve_relative_path_within_root(&cwd, relative_path)?;
        if let Some(parent) = target.absolute_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let existing = fs::read(&target.absolute_path).ok();
        let current_version = existing.as_ref().map(|bytes| sha256_hex(bytes));
        let current_contents = existing
            .as_ref()
            .and_then(|bytes| String::from_utf8(bytes.clone()).ok());
        if let Some(expected) = expected_version
            && !overwrite
            && current_version.as_deref() != Some(expected)
        {
            return Err(ProjectError::VersionConflict {
                current_contents,
                current_version,
                expected_version: expected.to_string(),
            });
        }
        fs::write(&target.absolute_path, contents.as_bytes())?;
        self.read_cache.remove(&target.absolute_path);
        self.invalidate(cwd);
        Ok(ProjectWriteFileResult {
            relative_path: target.relative_path,
            version: sha256_hex(contents.as_bytes()),
        })
    }

    pub fn rename_entry(
        &mut self,
        cwd: impl AsRef<Path>,
        relative_path: &str,
        next_relative_path: &str,
    ) -> Result<ProjectRenameEntryResult> {
        let source = Self::resolve_relative_path_within_root(&cwd, relative_path)?;
        let target = Self::resolve_relative_path_within_root(&cwd, next_relative_path)?;
        if source.relative_path == target.relative_path {
            return Ok(ProjectRenameEntryResult {
                previous_relative_path: source.relative_path,
                relative_path: target.relative_path,
            });
        }
        if !source.absolute_path.exists() {
            return Err(ProjectError::EntryMissing(source.relative_path));
        }
        if target.absolute_path.exists() {
            return Err(ProjectError::EntryAlreadyExists(target.relative_path));
        }
        if let Some(parent) = target.absolute_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&source.absolute_path, &target.absolute_path)?;
        self.read_cache
            .retain(|path, _| !path.starts_with(&source.absolute_path));
        self.invalidate(cwd);
        Ok(ProjectRenameEntryResult {
            previous_relative_path: source.relative_path,
            relative_path: target.relative_path,
        })
    }

    pub fn resolve_favicon(&self, cwd: impl AsRef<Path>) -> Result<ProjectFaviconResult> {
        let root = Self::normalize_workspace_root(cwd, false)?;
        for candidate in FAVICON_CANDIDATES {
            let path = root.join(candidate);
            if is_file_within_root(&root, &path) {
                return Ok(ProjectFaviconResult {
                    path: Some(path.to_string_lossy().to_string()),
                });
            }
        }

        for source_file in ICON_SOURCE_FILES {
            let source_path = root.join(source_file);
            if !is_file_within_root(&root, &source_path) {
                continue;
            }
            let Ok(source) = fs::read_to_string(&source_path) else {
                continue;
            };
            let Some(href) = extract_icon_href(&source) else {
                continue;
            };
            for candidate in icon_href_candidates(&root, &href) {
                if is_file_within_root(&root, &candidate) {
                    return Ok(ProjectFaviconResult {
                        path: Some(candidate.to_string_lossy().to_string()),
                    });
                }
            }
        }

        Ok(ProjectFaviconResult { path: None })
    }

    fn index_for(&mut self, root: &Path) -> Result<WorkspaceIndex> {
        if let Some(index) = self.index_cache.get(root) {
            return Ok(index.clone());
        }
        let index = build_workspace_index(root)?;
        self.index_cache.insert(root.to_path_buf(), index.clone());
        Ok(index)
    }

    fn cache_read(&mut self, path: PathBuf, fingerprint: String, result: ProjectReadFileResult) {
        self.read_cache.insert(
            path.clone(),
            ReadCacheEntry {
                fingerprint,
                result,
            },
        );
        self.read_cache_order.push_back(path);
        while self.read_cache.len() > READ_FILE_CACHE_MAX_ENTRIES {
            if let Some(oldest) = self.read_cache_order.pop_front() {
                self.read_cache.remove(&oldest);
            } else {
                break;
            }
        }
    }
}

fn build_workspace_index(root: &Path) -> Result<WorkspaceIndex> {
    let mut entries = Vec::new();
    let mut pending = VecDeque::from([root.to_path_buf()]);
    let mut truncated = false;
    while let Some(directory) = pending.pop_front() {
        let mut dirents = fs::read_dir(&directory)?.collect::<std::io::Result<Vec<_>>>()?;
        dirents.sort_by_key(|entry| entry.file_name());
        for entry in dirents {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if should_ignore_name(&file_name, entry.file_type()?.is_dir()) {
                continue;
            }
            let path = entry.path();
            let relative_path = to_posix(
                path.strip_prefix(root)
                    .map_err(|_| ProjectError::PathOutsideRoot)?,
            );
            let file_type = entry.file_type()?;
            let kind = if file_type.is_dir() {
                ProjectEntryKind::Directory
            } else if file_type.is_file() {
                ProjectEntryKind::File
            } else {
                continue;
            };
            entries.push(ProjectEntry {
                parent_path: parent_path(&relative_path),
                path: relative_path.clone(),
                kind: kind.clone(),
            });
            if matches!(kind, ProjectEntryKind::Directory) {
                pending.push_back(path);
            }
            if entries.len() >= WORKSPACE_INDEX_MAX_ENTRIES {
                truncated = true;
                pending.clear();
                break;
            }
        }
    }
    Ok(WorkspaceIndex { entries, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_paths_outside_workspace_root() {
        let temp = tempfile::tempdir().expect("tempdir");
        assert!(matches!(
            WorkspaceService::resolve_relative_path_within_root(temp.path(), "../x"),
            Err(ProjectError::PathOutsideRoot)
        ));
        assert!(matches!(
            WorkspaceService::resolve_relative_path_within_root(temp.path(), "/tmp/x"),
            Err(ProjectError::PathOutsideRoot)
        ));
    }

    #[test]
    fn writes_reads_and_conflicts_by_version() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut workspace = WorkspaceService::new();
        let written = workspace
            .write_file(temp.path(), "src/main.rs", "fn main() {}\n", None, false)
            .expect("write");
        let read = workspace
            .read_file(temp.path(), "src/main.rs")
            .expect("read");
        assert_eq!(read.version, written.version);
        let conflict = workspace
            .write_file(temp.path(), "src/main.rs", "new", Some("stale"), false)
            .expect_err("conflict");
        assert!(matches!(conflict, ProjectError::VersionConflict { .. }));
    }

    #[test]
    fn lists_and_searches_workspace_entries() {
        let temp = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(temp.path().join("src")).expect("mkdir");
        fs::write(temp.path().join("src/lib.rs"), "pub fn lib() {}\n").expect("write");
        fs::create_dir_all(temp.path().join("node_modules/pkg")).expect("ignored");
        fs::write(temp.path().join("node_modules/pkg/index.js"), "").expect("ignored file");
        let mut workspace = WorkspaceService::new();
        let tree = workspace.list_tree(temp.path()).expect("tree");
        assert!(tree.entries.iter().any(|entry| entry.path == "src/lib.rs"));
        assert!(
            !tree
                .entries
                .iter()
                .any(|entry| entry.path.contains("node_modules"))
        );
        let search = workspace
            .search_entries(temp.path(), "lib", 10)
            .expect("search");
        assert_eq!(search.entries[0].path, "src/lib.rs");
    }

    #[test]
    fn resolves_project_favicon_candidates_and_html_href() {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = WorkspaceService::new();
        fs::write(temp.path().join("favicon.svg"), "<svg />").expect("write");
        let direct = workspace.resolve_favicon(temp.path()).expect("favicon");
        assert!(direct.path.expect("path").ends_with("favicon.svg"));

        let temp = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(temp.path().join("public/brand")).expect("mkdir");
        fs::write(
            temp.path().join("index.html"),
            "<link rel=\"icon\" href=\"/brand/logo.svg\">",
        )
        .expect("html");
        fs::write(temp.path().join("public/brand/logo.svg"), "<svg />").expect("svg");
        let from_href = workspace.resolve_favicon(temp.path()).expect("favicon");
        assert!(
            from_href
                .path
                .expect("path")
                .ends_with("public/brand/logo.svg")
        );
    }
}
