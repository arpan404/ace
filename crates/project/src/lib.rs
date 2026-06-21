use ace_core::{IsoDateTime, ModelSelection, Project, ProjectIcon, ProjectId, ProjectScript};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT: usize = 200;
const PROJECT_READ_FILE_MAX_BYTES: u64 = 2 * 1024 * 1024;
const WORKSPACE_INDEX_MAX_ENTRIES: usize = 25_000;
const READ_FILE_CACHE_MAX_ENTRIES: usize = 128;
const FAVICON_CANDIDATES: &[&str] = &[
    "favicon.svg",
    "favicon.ico",
    "favicon.png",
    "public/favicon.svg",
    "public/favicon.ico",
    "public/favicon.png",
    "app/favicon.ico",
    "app/favicon.png",
    "app/icon.svg",
    "app/icon.png",
    "app/icon.ico",
    "src/favicon.ico",
    "src/favicon.svg",
    "src/app/favicon.ico",
    "src/app/icon.svg",
    "src/app/icon.png",
    "assets/icon.svg",
    "assets/icon.png",
    "assets/logo.svg",
    "assets/logo.png",
];
const ICON_SOURCE_FILES: &[&str] = &[
    "index.html",
    "public/index.html",
    "app/routes/__root.tsx",
    "src/routes/__root.tsx",
    "app/root.tsx",
    "src/root.tsx",
    "src/index.html",
];

const IGNORED_DIRECTORY_NAMES: &[&str] = &[
    ".git",
    ".convex",
    "node_modules",
    ".turbo",
    "dist",
    "build",
    "out",
    ".cache",
];
const IGNORED_FILE_NAMES: &[&str] = &[".DS_Store", "Thumbs.db", "Desktop.ini"];

#[derive(Debug, Error)]
pub enum ProjectError {
    #[error("project title cannot be empty")]
    EmptyTitle,
    #[error("workspace root does not exist: {0}")]
    WorkspaceMissing(PathBuf),
    #[error("workspace root is not a directory: {0}")]
    WorkspaceNotDirectory(PathBuf),
    #[error("workspace path must stay within the project root")]
    PathOutsideRoot,
    #[error("entry already exists: {0}")]
    EntryAlreadyExists(String),
    #[error("entry does not exist: {0}")]
    EntryMissing(String),
    #[error("only regular text files are supported")]
    UnsupportedFile,
    #[error("files larger than {PROJECT_READ_FILE_MAX_BYTES} bytes are not opened")]
    FileTooLarge,
    #[error("the file changed on disk after it was opened")]
    VersionConflict {
        current_contents: Option<String>,
        current_version: Option<String>,
        expected_version: String,
    },
    #[error("database error: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, ProjectError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSummary {
    pub id: ProjectId,
    pub title: String,
    pub workspace_root: String,
    pub default_model_selection: Option<ModelSelection>,
    pub scripts: Vec<ProjectScript>,
    pub icon: Option<ProjectIcon>,
    pub created_at: IsoDateTime,
    pub updated_at: IsoDateTime,
    pub archived_at: Option<IsoDateTime>,
    pub deleted_at: Option<IsoDateTime>,
    pub active_thread_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddProject {
    pub workspace_root: String,
    pub title: Option<String>,
    pub default_model_selection: Option<ModelSelection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddProjectResult {
    pub status: AddProjectStatus,
    pub project: ProjectSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AddProjectStatus {
    Created,
    Existing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct UpdateProject {
    pub title: Option<String>,
    pub workspace_root: Option<String>,
    pub default_model_selection: Option<Option<ModelSelection>>,
    pub scripts: Option<Vec<ProjectScript>>,
    pub icon: Option<Option<ProjectIcon>>,
    pub archived_at: Option<Option<IsoDateTime>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoveProjectResult {
    pub project: ProjectSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectEntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectEntry {
    pub path: String,
    pub kind: ProjectEntryKind,
    pub parent_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectEntriesResult {
    pub entries: Vec<ProjectEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectReadFileResult {
    pub relative_path: String,
    pub contents: String,
    pub size_bytes: u64,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectWriteFileResult {
    pub relative_path: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectCreateEntryResult {
    pub kind: ProjectEntryKind,
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectRenameEntryResult {
    pub previous_relative_path: String,
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectDeleteEntryResult {
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectFaviconResult {
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPath {
    absolute_path: PathBuf,
    relative_path: String,
}

#[derive(Debug, Clone)]
struct WorkspaceIndex {
    entries: Vec<ProjectEntry>,
    truncated: bool,
}

#[derive(Debug, Clone)]
struct ReadCacheEntry {
    fingerprint: String,
    result: ProjectReadFileResult,
}

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

#[derive(Debug)]
pub struct ProjectRegistry {
    connection: Connection,
}

impl ProjectRegistry {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    pub fn from_connection(connection: Connection) -> Result<Self> {
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS projects (
                project_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                workspace_root TEXT NOT NULL,
                default_model_selection_json TEXT,
                scripts_json TEXT NOT NULL,
                icon_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                archived_at TEXT,
                deleted_at TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_workspace_active
            ON projects(workspace_root)
            WHERE deleted_at IS NULL;
            ",
        )?;
        Ok(Self { connection })
    }

    pub fn list(&self) -> Result<Vec<ProjectSummary>> {
        let mut statement = self.connection.prepare(
            "SELECT project_id, title, workspace_root, default_model_selection_json, scripts_json,
                    icon_json, created_at, updated_at, archived_at, deleted_at
             FROM projects
             ORDER BY created_at ASC, project_id ASC",
        )?;
        let rows = statement.query_map([], decode_project_row)?;
        rows.map(|row| {
            row.map(|project| summarize(project, 0))
                .map_err(ProjectError::from)
        })
        .collect()
    }

    pub fn add(&self, input: AddProject) -> Result<AddProjectResult> {
        let workspace_root =
            WorkspaceService::normalize_workspace_root(input.workspace_root, false)?
                .to_string_lossy()
                .to_string();
        if let Some(existing) = self.find_active_by_workspace_root(&workspace_root)? {
            return Ok(AddProjectResult {
                status: AddProjectStatus::Existing,
                project: summarize(existing, 0),
            });
        }
        let title = match input.title {
            Some(title) if !title.trim().is_empty() => title.trim().to_string(),
            Some(_) => return Err(ProjectError::EmptyTitle),
            None => Path::new(&workspace_root)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Project")
                .to_string(),
        };
        let now = now_iso();
        let project = Project {
            id: ProjectId::new(),
            title,
            workspace_root,
            default_model_selection: input.default_model_selection,
            scripts: Vec::new(),
            icon: None,
            created_at: now.clone(),
            updated_at: now,
            archived_at: None,
            deleted_at: None,
        };
        self.upsert_project(&project)?;
        Ok(AddProjectResult {
            status: AddProjectStatus::Created,
            project: summarize(project, 0),
        })
    }

    pub fn update(&self, project_id: ProjectId, patch: UpdateProject) -> Result<ProjectSummary> {
        let mut project = self
            .get_project(project_id)?
            .ok_or_else(|| ProjectError::EntryMissing("project".to_string()))?;
        if let Some(title) = patch.title {
            let trimmed = title.trim();
            if trimmed.is_empty() {
                return Err(ProjectError::EmptyTitle);
            }
            project.title = trimmed.to_string();
        }
        if let Some(workspace_root) = patch.workspace_root {
            project.workspace_root =
                WorkspaceService::normalize_workspace_root(workspace_root, false)?
                    .to_string_lossy()
                    .to_string();
        }
        if let Some(default_model_selection) = patch.default_model_selection {
            project.default_model_selection = default_model_selection;
        }
        if let Some(scripts) = patch.scripts {
            project.scripts = scripts;
        }
        if let Some(icon) = patch.icon {
            project.icon = icon;
        }
        if let Some(archived_at) = patch.archived_at {
            project.archived_at = archived_at;
        }
        project.updated_at = now_iso();
        self.upsert_project(&project)?;
        Ok(summarize(project, 0))
    }

    pub fn delete(&self, project_id: ProjectId) -> Result<RemoveProjectResult> {
        let mut project = self
            .get_project(project_id)?
            .ok_or_else(|| ProjectError::EntryMissing("project".to_string()))?;
        project.deleted_at = Some(now_iso());
        project.updated_at = project.deleted_at.clone().unwrap_or_else(now_iso);
        self.upsert_project(&project)?;
        Ok(RemoveProjectResult {
            project: summarize(project, 0),
        })
    }

    fn find_active_by_workspace_root(&self, workspace_root: &str) -> Result<Option<Project>> {
        self.connection
            .query_row(
                "SELECT project_id, title, workspace_root, default_model_selection_json, scripts_json,
                        icon_json, created_at, updated_at, archived_at, deleted_at
                 FROM projects
                 WHERE workspace_root = ?1 AND deleted_at IS NULL",
                [workspace_root],
                decode_project_row,
            )
            .optional()
            .map_err(ProjectError::from)
    }

    fn get_project(&self, project_id: ProjectId) -> Result<Option<Project>> {
        self.connection
            .query_row(
                "SELECT project_id, title, workspace_root, default_model_selection_json, scripts_json,
                        icon_json, created_at, updated_at, archived_at, deleted_at
                 FROM projects
                 WHERE project_id = ?1",
                [serde_json::to_string(&project_id)?],
                decode_project_row,
            )
            .optional()
            .map_err(ProjectError::from)
    }

    fn upsert_project(&self, project: &Project) -> Result<()> {
        self.connection.execute(
            "INSERT INTO projects (
                project_id, title, workspace_root, default_model_selection_json, scripts_json,
                icon_json, created_at, updated_at, archived_at, deleted_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(project_id) DO UPDATE SET
                title = excluded.title,
                workspace_root = excluded.workspace_root,
                default_model_selection_json = excluded.default_model_selection_json,
                scripts_json = excluded.scripts_json,
                icon_json = excluded.icon_json,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                archived_at = excluded.archived_at,
                deleted_at = excluded.deleted_at",
            params![
                serde_json::to_string(&project.id)?,
                project.title,
                project.workspace_root,
                optional_json(&project.default_model_selection)?,
                serde_json::to_string(&project.scripts)?,
                optional_json(&project.icon)?,
                project.created_at,
                project.updated_at,
                project.archived_at,
                project.deleted_at
            ],
        )?;
        Ok(())
    }
}

fn decode_project_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    let id_json: String = row.get(0)?;
    let model_json: Option<String> = row.get(3)?;
    let scripts_json: String = row.get(4)?;
    let icon_json: Option<String> = row.get(5)?;
    Ok(Project {
        id: serde_json::from_str(&id_json).map_err(json_to_sql)?,
        title: row.get(1)?,
        workspace_root: row.get(2)?,
        default_model_selection: model_json
            .map(|value| serde_json::from_str(&value).map_err(json_to_sql))
            .transpose()?,
        scripts: serde_json::from_str(&scripts_json).map_err(json_to_sql)?,
        icon: icon_json
            .map(|value| serde_json::from_str(&value).map_err(json_to_sql))
            .transpose()?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        archived_at: row.get(8)?,
        deleted_at: row.get(9)?,
    })
}

fn json_to_sql(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

fn optional_json<T: Serialize>(value: &Option<T>) -> Result<Option<String>> {
    value
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(ProjectError::from)
}

fn summarize(project: Project, active_thread_count: u64) -> ProjectSummary {
    ProjectSummary {
        id: project.id,
        title: project.title,
        workspace_root: project.workspace_root,
        default_model_selection: project.default_model_selection,
        scripts: project.scripts,
        icon: project.icon,
        created_at: project.created_at,
        updated_at: project.updated_at,
        archived_at: project.archived_at,
        deleted_at: project.deleted_at,
        active_thread_count,
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

fn should_ignore_name(name: &str, is_directory: bool) -> bool {
    IGNORED_FILE_NAMES.contains(&name)
        || name.starts_with("._")
        || (is_directory && IGNORED_DIRECTORY_NAMES.contains(&name))
}

fn is_file_within_root(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root).is_ok() && path.is_file()
}

fn icon_href_candidates(root: &Path, href: &str) -> Vec<PathBuf> {
    let clean = href
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .trim_start_matches('/');
    vec![root.join("public").join(clean), root.join(clean)]
}

fn extract_icon_href(source: &str) -> Option<String> {
    extract_html_icon_href(source).or_else(|| extract_object_icon_href(source))
}

fn extract_html_icon_href(source: &str) -> Option<String> {
    for tag in source.match_indices("<link").filter_map(|(start, _)| {
        let end = source[start..].find('>')?;
        Some(&source[start..start + end + 1])
    }) {
        let lower = tag.to_lowercase();
        if !(lower.contains("rel=\"icon\"")
            || lower.contains("rel='icon'")
            || lower.contains("rel=\"shortcut icon\"")
            || lower.contains("rel='shortcut icon'"))
        {
            continue;
        }
        if let Some(href) = extract_quoted_attr(tag, "href=") {
            return Some(href);
        }
    }
    None
}

fn extract_object_icon_href(source: &str) -> Option<String> {
    for segment in source.split(['{', '}']) {
        let lower = segment.to_lowercase();
        if !(lower.contains("rel: \"icon\"")
            || lower.contains("rel:'icon'")
            || lower.contains("rel: 'icon'")
            || lower.contains("rel:\"icon\"")
            || lower.contains("rel: \"shortcut icon\"")
            || lower.contains("rel: 'shortcut icon'"))
        {
            continue;
        }
        if let Some(href) = extract_quoted_attr(segment, "href") {
            return Some(href);
        }
    }
    None
}

fn extract_quoted_attr(source: &str, name: &str) -> Option<String> {
    let lower = source.to_lowercase();
    let start = lower.find(name)?;
    let after_name = &source[start + name.len()..];
    let after_separator = after_name
        .trim_start()
        .strip_prefix(':')
        .unwrap_or(after_name)
        .trim_start()
        .strip_prefix('=')
        .unwrap_or(after_name.trim_start())
        .trim_start();
    let quote = after_separator.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let rest = &after_separator[quote.len_utf8()..];
    let end = rest.find(quote)?;
    Some(rest[..end].to_string())
}

fn score_entry(entry: &ProjectEntry, query: &str) -> Option<usize> {
    if query.is_empty() {
        return Some(if matches!(entry.kind, ProjectEntryKind::Directory) {
            0
        } else {
            1
        });
    }
    let path = entry.path.to_lowercase();
    let name = Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&path)
        .to_string();
    if name == query {
        Some(0)
    } else if path == query {
        Some(1)
    } else if name.starts_with(query) {
        Some(2)
    } else if path.starts_with(query) {
        Some(3)
    } else if path.contains(&format!("/{query}")) {
        Some(4)
    } else if name.contains(query) {
        Some(5)
    } else if path.contains(query) {
        Some(6)
    } else {
        subsequence_score(&name, query)
            .map(|score| 100 + score)
            .or_else(|| subsequence_score(&path, query).map(|score| 200 + score))
    }
}

fn subsequence_score(value: &str, query: &str) -> Option<usize> {
    let mut query_chars = query.chars();
    let mut current = query_chars.next()?;
    let mut first_match = None;
    let mut previous_match = None;
    let mut gap_penalty = 0usize;
    let mut matched = 0usize;
    for (index, ch) in value.chars().enumerate() {
        if ch != current {
            continue;
        }
        first_match.get_or_insert(index);
        if let Some(previous) = previous_match {
            gap_penalty += index - previous - 1;
        }
        previous_match = Some(index);
        matched += 1;
        if let Some(next) = query_chars.next() {
            current = next;
        } else {
            let first = first_match.unwrap_or(index);
            let span_penalty = index - first + 1 - matched;
            return Some(
                first * 2
                    + gap_penalty * 3
                    + span_penalty
                    + value.len().saturating_sub(query.len()).min(64),
            );
        }
    }
    None
}

fn normalize_query(query: &str) -> String {
    query
        .trim()
        .trim_start_matches(['@', '.', '/'])
        .to_lowercase()
}

fn expand_home(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if raw == "~"
        && let Some(home) = std::env::var_os("HOME")
    {
        return PathBuf::from(home);
    }
    if let Some(rest) = raw.strip_prefix("~/")
        && let Some(home) = std::env::var_os("HOME")
    {
        return PathBuf::from(home).join(rest);
    }
    path.to_path_buf()
}

fn to_posix(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn parent_path(path: &str) -> Option<String> {
    path.rsplit_once('/').map(|(parent, _)| parent.to_string())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn file_fingerprint(metadata: &fs::Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}:{modified}", metadata.len())
}

fn now_iso() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:09}Z", now.as_secs(), now.subsec_nanos())
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
    fn registry_adds_projects_idempotently() {
        let temp = tempfile::tempdir().expect("tempdir");
        let registry = ProjectRegistry::from_connection(Connection::open_in_memory().expect("db"))
            .expect("registry");
        let first = registry
            .add(AddProject {
                workspace_root: temp.path().to_string_lossy().to_string(),
                title: None,
                default_model_selection: None,
            })
            .expect("add");
        let second = registry
            .add(AddProject {
                workspace_root: temp.path().to_string_lossy().to_string(),
                title: None,
                default_model_selection: None,
            })
            .expect("add existing");
        assert_eq!(first.project.id, second.project.id);
        assert_eq!(registry.list().expect("list").len(), 1);
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
