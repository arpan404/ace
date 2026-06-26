use crate::backend::{
    BackendError, BackendHostClient, ProjectsAdd, ProjectsDelete, ProjectsProjectThreads,
    ProjectsSnapshot, ProjectsThreadMessages,
};
use ace_core::{Project, ProjectId, ThreadId};
use ace_project::ProjectSummary;
use ace_protocol::project::{
    ProjectAddRequest, ProjectDeleteRequest, ProjectSnapshotRequest, ProjectThreadsRequest,
    ThreadMessagesRequest,
};
use ace_runtime::{
    chat::{
        ChatMessageProjection, ChatProjection, ComposerDraft, CreationContext, InteractionMode,
        RuntimeMode, SidebarMetadata, SidebarProjection, ThreadDraft, ThreadStatus, ThreadSummary,
        build_chat_projection, build_sidebar_projection, resolve_thread_creation_options,
    },
    threads::{AgentRuntimeSnapshot, ExecutionLocation},
};
use std::{
    collections::HashMap,
    time::{SystemTime, UNIX_EPOCH},
};

const INITIAL_PROJECT_THREAD_LIMIT: usize = 5;
const PROJECT_THREAD_PAGE_SIZE: usize = 5;

#[derive(Debug, Clone)]
pub struct DesktopStore {
    host: Option<BackendHostClient>,
    projects: Vec<Project>,
    threads: Vec<ThreadSummary>,
    thread_drafts: HashMap<ThreadId, ThreadDraft>,
    project_drafts: HashMap<ProjectId, ThreadId>,
    composer_drafts: HashMap<ThreadId, ComposerDraft>,
    persisted_messages: HashMap<ThreadId, Vec<ChatMessageProjection>>,
    thread_counts: HashMap<ProjectId, usize>,
    project_thread_limits: HashMap<ProjectId, usize>,
    metadata: SidebarMetadata,
    runtime: AgentRuntimeSnapshot,
    now_counter: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopProjection {
    pub sidebar: SidebarProjection,
    pub chat: ChatProjection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerPayload {
    pub prompt: String,
}

impl DesktopStore {
    #[must_use]
    pub fn new() -> Self {
        Self {
            host: None,
            projects: Vec::new(),
            threads: Vec::new(),
            thread_drafts: HashMap::new(),
            project_drafts: HashMap::new(),
            composer_drafts: HashMap::new(),
            persisted_messages: HashMap::new(),
            thread_counts: HashMap::new(),
            project_thread_limits: HashMap::new(),
            metadata: SidebarMetadata::default(),
            runtime: AgentRuntimeSnapshot::default(),
            now_counter: now_millis(),
        }
    }

    pub fn load_from_host(host: &BackendHostClient) -> Result<Self, BackendError> {
        let snapshot = host.request::<ProjectsSnapshot>(&ProjectSnapshotRequest {})?;
        let mut store = Self::new();
        store.host = Some(host.clone());
        store.replace_snapshot(snapshot.projects, snapshot.threads, snapshot.thread_counts);
        Ok(store)
    }

    pub fn replace_snapshot(
        &mut self,
        projects: Vec<Project>,
        threads: Vec<ThreadSummary>,
        thread_counts: HashMap<ProjectId, usize>,
    ) {
        self.projects = projects;
        self.threads = threads;
        self.thread_counts = thread_counts;
        self.project_thread_limits.clear();
        for project in &self.projects {
            let loaded = self
                .threads
                .iter()
                .filter(|thread| thread.project_id == project.id)
                .count();
            let total = *self.thread_counts.entry(project.id).or_insert(loaded);
            self.project_thread_limits.insert(
                project.id,
                loaded.min(total.min(INITIAL_PROJECT_THREAD_LIMIT)),
            );
        }
        self.thread_drafts.clear();
        self.project_drafts.clear();
        self.composer_drafts.clear();
        self.persisted_messages.clear();
        self.metadata.active_thread_id = self
            .threads
            .iter()
            .find(|thread| !thread.archived)
            .map(|thread| thread.id.clone());
    }

    #[must_use]
    pub fn projection(&self) -> DesktopProjection {
        let sidebar_threads = self.visible_sidebar_threads();
        let mut sidebar =
            build_sidebar_projection(&self.projects, &sidebar_threads, &self.metadata);
        sidebar.total_thread_count = 0;
        for group in &mut sidebar.projects {
            group.project.thread_count = self
                .thread_counts
                .get(&group.project.id)
                .copied()
                .unwrap_or(group.threads.len());
            sidebar.total_thread_count += group.project.thread_count;
            for thread in &mut group.threads {
                thread.latest_message_preview = None;
            }
        }
        let active_thread = self.active_thread().cloned();
        let composer = self
            .metadata
            .active_thread_id
            .as_ref()
            .and_then(|id| self.composer_drafts.get(id))
            .cloned();
        let mut chat = build_chat_projection(active_thread, composer, &self.runtime);
        if chat.messages.is_empty()
            && let Some(thread_id) = chat.active_thread.as_ref().map(|thread| &thread.id)
        {
            chat.messages = self
                .persisted_messages
                .get(thread_id)
                .cloned()
                .unwrap_or_default();
        }
        DesktopProjection { sidebar, chat }
    }

    pub fn new_thread(&mut self, project_id: ProjectId) -> ThreadId {
        if let Some(existing) = self.project_drafts.get(&project_id).cloned() {
            self.open_thread(existing.clone());
            return existing;
        }

        let active = self.active_thread();
        let active_draft = self
            .metadata
            .active_thread_id
            .as_ref()
            .and_then(|id| self.thread_drafts.get(id))
            .cloned();
        let options = resolve_thread_creation_options(
            project_id,
            active,
            &CreationContext {
                active_thread_id: self.metadata.active_thread_id.clone(),
                active_draft,
                default_env_mode: ExecutionLocation::Local,
            },
        );

        let thread_id = ThreadId::new();
        let created_at = self.next_timestamp();
        let draft = ThreadDraft {
            thread_id: thread_id.clone(),
            project_id,
            created_at: created_at.clone(),
            runtime_mode: options.runtime_mode,
            interaction_mode: options.interaction_mode,
            branch: options.branch.clone(),
            worktree_path: options.worktree_path.clone(),
            env_mode: options.env_mode,
        };
        let thread = ThreadSummary {
            id: thread_id.clone(),
            provider_thread_id: None,
            project_id,
            title: "New chat".to_string(),
            status: ThreadStatus::Draft,
            provider: ace_core::ProviderKind::Codex,
            model: Some("gpt-5-codex".to_string()),
            pinned: false,
            archived: false,
            unseen_completion: false,
            latest_activity_at: created_at.clone(),
            latest_message_preview: None,
            pending_approvals: 0,
            pending_user_inputs: 0,
            has_actionable_plan: false,
            branch: options.branch,
            worktree_path: options.worktree_path,
        };
        self.thread_drafts.insert(thread_id.clone(), draft);
        self.project_drafts.insert(project_id, thread_id.clone());
        self.composer_drafts.insert(
            thread_id.clone(),
            ComposerDraft::empty(thread_id.clone(), created_at),
        );
        self.threads.push(thread);
        *self.thread_counts.entry(project_id).or_insert(0) += 1;
        self.project_thread_limits
            .entry(project_id)
            .and_modify(|limit| *limit = (*limit + 1).max(INITIAL_PROJECT_THREAD_LIMIT))
            .or_insert(INITIAL_PROJECT_THREAD_LIMIT);
        self.open_thread(thread_id.clone());
        thread_id
    }

    pub fn new_thread_for_first_project(&mut self) {
        if let Some(project_id) = self.projects.first().map(|project| project.id) {
            self.new_thread(project_id);
        }
    }

    pub fn open_thread(&mut self, thread_id: ThreadId) {
        self.hydrate_thread_messages(&thread_id);
        self.metadata.active_thread_id = Some(thread_id.clone());
        self.metadata.unseen_completed_thread_ids.remove(&thread_id);
    }

    pub fn send_message(&mut self, thread_id: ThreadId, payload: ComposerPayload) {
        let now = self.next_timestamp();
        let trimmed = payload.prompt.trim();
        if trimmed.is_empty() {
            return;
        }

        if let Some(thread) = self
            .threads
            .iter_mut()
            .find(|thread| thread.id == thread_id && !thread.archived)
        {
            thread.status = ThreadStatus::Working;
            thread.latest_activity_at = now.clone();
            thread.latest_message_preview = Some(trimmed.to_string());
            if thread.title == "New chat" {
                thread.title = title_from_prompt(trimmed);
            }
        }

        self.project_drafts.retain(|_, id| id != &thread_id);
        self.thread_drafts.remove(&thread_id);
        self.composer_drafts.insert(
            thread_id.clone(),
            ComposerDraft {
                thread_id,
                prompt: String::new(),
                model_selection: Default::default(),
                runtime_mode: RuntimeMode::Normal,
                interaction_mode: InteractionMode::Chat,
                image_paths: Vec::new(),
                terminal_contexts: Vec::new(),
                updated_at: now,
            },
        );
    }

    pub fn send_active_composer(&mut self) {
        let Some(thread_id) = self.metadata.active_thread_id.clone() else {
            return;
        };
        let prompt = self
            .composer_drafts
            .get(&thread_id)
            .map(|draft| draft.prompt.clone())
            .unwrap_or_else(|| "Continue".to_string());
        self.send_message(thread_id, ComposerPayload { prompt });
    }

    pub fn interrupt_turn(&mut self, thread_id: ThreadId) {
        if let Some(thread) = self
            .threads
            .iter_mut()
            .find(|thread| thread.id == thread_id)
        {
            thread.status = ThreadStatus::Idle;
            thread.latest_message_preview = Some("Interrupted".to_string());
        }
    }

    pub fn interrupt_active_turn(&mut self) {
        if let Some(thread_id) = self.metadata.active_thread_id.clone() {
            self.interrupt_turn(thread_id);
        }
    }

    #[allow(dead_code)]
    pub fn rename_thread(&mut self, thread_id: ThreadId, name: String) {
        if let Some(thread) = self
            .threads
            .iter_mut()
            .find(|thread| thread.id == thread_id)
        {
            thread.title = name;
        }
    }

    pub fn archive_thread(&mut self, thread_id: ThreadId) {
        if let Some(thread) = self
            .threads
            .iter_mut()
            .find(|thread| thread.id == thread_id)
        {
            thread.archived = true;
            thread.status = ThreadStatus::Archived;
        }
        self.metadata.archived_thread_ids.insert(thread_id.clone());
        if self.metadata.active_thread_id.as_ref() == Some(&thread_id) {
            self.metadata.active_thread_id = self
                .threads
                .iter()
                .find(|thread| !thread.archived)
                .map(|thread| thread.id.clone());
        }
    }

    pub fn archive_active_thread(&mut self) {
        if let Some(thread_id) = self.metadata.active_thread_id.clone() {
            self.archive_thread(thread_id);
        }
    }

    #[allow(dead_code)]
    pub fn delete_thread(&mut self, thread_id: ThreadId) {
        self.threads.retain(|thread| thread.id != thread_id);
        self.composer_drafts.remove(&thread_id);
        self.persisted_messages.remove(&thread_id);
        self.thread_drafts.remove(&thread_id);
        self.project_drafts.retain(|_, id| id != &thread_id);
        self.metadata.pinned_thread_ids.remove(&thread_id);
        self.metadata.archived_thread_ids.remove(&thread_id);
        if self.metadata.active_thread_id.as_ref() == Some(&thread_id) {
            self.metadata.active_thread_id = self.threads.first().map(|thread| thread.id.clone());
        }
    }

    pub fn pin_thread(&mut self, thread_id: ThreadId, pinned: bool) {
        if pinned {
            self.metadata.pinned_thread_ids.insert(thread_id.clone());
        } else {
            self.metadata.pinned_thread_ids.remove(&thread_id);
        }
        if let Some(thread) = self
            .threads
            .iter_mut()
            .find(|thread| thread.id == thread_id)
        {
            thread.pinned = pinned;
        }
    }

    pub fn toggle_pin_active_thread(&mut self) {
        if let Some(thread_id) = self.metadata.active_thread_id.clone() {
            let pinned = !self.metadata.pinned_thread_ids.contains(&thread_id);
            self.pin_thread(thread_id, pinned);
        }
    }

    pub fn add_project(&mut self, path: String) -> ProjectId {
        if let Some(existing) = self
            .projects
            .iter()
            .find(|project| project.workspace_root == path && project.deleted_at.is_none())
        {
            return existing.id;
        }

        let project_id = ProjectId::new();
        let name = path
            .rsplit('/')
            .find(|segment| !segment.is_empty())
            .unwrap_or("Project")
            .to_string();
        let now = self.next_timestamp();
        self.projects.push(Project {
            id: project_id,
            title: name,
            workspace_root: path,
            default_model_selection: None,
            scripts: Vec::new(),
            icon: None,
            created_at: now.clone(),
            updated_at: now,
            archived_at: None,
            deleted_at: None,
        });
        self.thread_counts.insert(project_id, 0);
        self.project_thread_limits
            .insert(project_id, INITIAL_PROJECT_THREAD_LIMIT);
        project_id
    }

    pub fn add_current_directory_project(
        &mut self,
        host: Option<&BackendHostClient>,
    ) -> Option<ProjectId> {
        let path = std::env::current_dir()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string());
        let project_id = if let Some(host) = host {
            match host.request::<ProjectsAdd>(&ProjectAddRequest {
                workspace_root: path,
                title: None,
                default_model_selection: None,
            }) {
                Ok(result) => {
                    let project_id = result.project.id;
                    self.upsert_project(result.project);
                    project_id
                }
                Err(error) => {
                    tracing::warn!(%error, "failed to add project through backend host");
                    return None;
                }
            }
        } else {
            self.add_project(path)
        };
        self.new_thread(project_id);
        Some(project_id)
    }

    #[allow(dead_code)]
    pub fn rename_project(&mut self, project_id: ProjectId, name: String) {
        if let Some(project) = self
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
        {
            project.title = name;
        }
    }

    pub fn archive_or_delete_project(
        &mut self,
        project_id: ProjectId,
        host: Option<&BackendHostClient>,
    ) {
        if let Some(host) = host
            && let Err(error) = host.request::<ProjectsDelete>(&ProjectDeleteRequest { project_id })
        {
            tracing::warn!(%error, "failed to delete project through backend host");
            return;
        }
        let now = self.next_timestamp();
        if let Some(project) = self
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
        {
            project.archived_at = Some(now);
        }
        self.threads
            .retain(|thread| thread.project_id != project_id);
        self.thread_counts.remove(&project_id);
        self.project_thread_limits.remove(&project_id);
        self.project_drafts.remove(&project_id);
        self.thread_drafts
            .retain(|_, draft| draft.project_id != project_id);
        self.composer_drafts
            .retain(|thread_id, _| self.threads.iter().any(|thread| &thread.id == thread_id));
        self.persisted_messages
            .retain(|thread_id, _| self.threads.iter().any(|thread| &thread.id == thread_id));
        if self
            .metadata
            .active_thread_id
            .as_ref()
            .is_some_and(|active| !self.threads.iter().any(|thread| &thread.id == active))
        {
            self.metadata.active_thread_id = self.threads.first().map(|thread| thread.id.clone());
        }
    }

    pub fn show_more_project_threads(&mut self, project_id: ProjectId) {
        let loaded = self
            .project_thread_limits
            .get(&project_id)
            .copied()
            .unwrap_or_else(|| self.loaded_project_thread_count(project_id));
        let total = self
            .thread_counts
            .get(&project_id)
            .copied()
            .unwrap_or(loaded);
        if loaded < total {
            self.load_project_threads(project_id, (loaded + PROJECT_THREAD_PAGE_SIZE).min(total));
        }
    }

    pub fn show_less_project_threads(&mut self, project_id: ProjectId) {
        self.load_project_threads(project_id, INITIAL_PROJECT_THREAD_LIMIT);
    }

    fn loaded_project_thread_count(&self, project_id: ProjectId) -> usize {
        self.threads
            .iter()
            .filter(|thread| thread.project_id == project_id)
            .count()
    }

    fn visible_sidebar_threads(&self) -> Vec<ThreadSummary> {
        let mut remaining = self.project_thread_limits.clone();
        let capacity = remaining
            .values()
            .copied()
            .sum::<usize>()
            .min(self.threads.len());
        let mut threads = Vec::with_capacity(capacity);
        for thread in &self.threads {
            let Some(limit) = remaining.get_mut(&thread.project_id) else {
                continue;
            };
            if *limit == 0 {
                continue;
            }
            threads.push(thread.clone());
            *limit -= 1;
        }
        threads
    }

    fn load_project_threads(&mut self, project_id: ProjectId, limit: usize) {
        let Some(host) = &self.host else {
            self.project_thread_limits.insert(project_id, limit);
            return;
        };
        match host.request::<ProjectsProjectThreads>(&ProjectThreadsRequest { project_id, limit }) {
            Ok(mut threads) => {
                self.threads
                    .retain(|thread| thread.project_id != project_id);
                self.threads.append(&mut threads);
                self.project_thread_limits.insert(project_id, limit);
            }
            Err(error) => tracing::warn!(%error, "failed to load project threads from backend"),
        }
    }

    fn hydrate_thread_messages(&mut self, thread_id: &ThreadId) {
        if self.persisted_messages.contains_key(thread_id) {
            return;
        }
        let Some(host) = &self.host else {
            return;
        };
        match host.request::<ProjectsThreadMessages>(&ThreadMessagesRequest {
            thread_id: thread_id.clone(),
            limit: 200,
        }) {
            Ok(response) => {
                self.persisted_messages
                    .insert(thread_id.clone(), response.messages);
            }
            Err(error) => tracing::warn!(%error, "failed to hydrate thread messages from backend"),
        }
    }

    fn active_thread(&self) -> Option<&ThreadSummary> {
        self.metadata
            .active_thread_id
            .as_ref()
            .and_then(|active| self.threads.iter().find(|thread| &thread.id == active))
    }

    fn next_timestamp(&mut self) -> String {
        let value = timestamp(self.now_counter);
        self.now_counter += 1;
        value
    }
}

impl DesktopStore {
    fn upsert_project(&mut self, project: ProjectSummary) {
        let project = project_from_summary(project);
        if let Some(existing) = self
            .projects
            .iter_mut()
            .find(|existing| existing.id == project.id)
        {
            *existing = project;
        } else {
            self.thread_counts.entry(project.id).or_insert(0);
            self.project_thread_limits
                .entry(project.id)
                .or_insert(INITIAL_PROJECT_THREAD_LIMIT);
            self.projects.push(project);
        }
    }
}

fn project_from_summary(value: ProjectSummary) -> Project {
    Project {
        id: value.id,
        title: value.title,
        workspace_root: value.workspace_root,
        default_model_selection: value.default_model_selection,
        scripts: value.scripts,
        icon: value.icon,
        created_at: value.created_at,
        updated_at: value.updated_at,
        archived_at: value.archived_at,
        deleted_at: value.deleted_at,
    }
}

fn title_from_prompt(prompt: &str) -> String {
    let mut title = prompt
        .split_whitespace()
        .take(6)
        .collect::<Vec<_>>()
        .join(" ");
    if title.len() > 54 {
        title.truncate(54);
    }
    title
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_millis() as u64
}

fn timestamp(value: u64) -> String {
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_thread_reuses_existing_project_draft() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let first = store.new_thread(project_id);
        let second = store.new_thread(project_id);
        assert_eq!(first, second);
        assert_eq!(store.project_drafts.get(&project_id), Some(&first));
    }

    #[test]
    fn first_send_promotes_draft_thread() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store.send_message(
            thread_id.clone(),
            ComposerPayload {
                prompt: "Port the project sidebar".to_string(),
            },
        );
        let thread = store
            .threads
            .iter()
            .find(|thread| thread.id == thread_id)
            .expect("thread");
        assert_eq!(thread.status, ThreadStatus::Working);
        assert!(thread.provider_thread_id.is_none());
        assert!(!store.project_drafts.contains_key(&project_id));
        assert!(!store.thread_drafts.contains_key(&thread_id));
    }

    #[test]
    fn pin_and_archive_update_sidebar_projection() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let active = store.new_thread(project_id);
        store.pin_thread(active.clone(), true);
        assert!(store.metadata.pinned_thread_ids.contains(&active));
        store.archive_thread(active.clone());
        assert!(store.metadata.archived_thread_ids.contains(&active));
        assert_ne!(store.metadata.active_thread_id, Some(active));
    }

    #[test]
    fn add_project_deduplicates_workspace_root() {
        let mut store = DesktopStore::new();
        let first = store.add_project("/tmp/project".to_string());
        let second = store.add_project("/tmp/project".to_string());
        assert_eq!(first, second);
        assert_eq!(store.projects.len(), 1);
    }

    #[test]
    fn archiving_project_removes_its_threads_from_sidebar() {
        let mut store = DesktopStore::new();
        let first_project = store.add_project("/tmp/first".to_string());
        let second_project = store.add_project("/tmp/second".to_string());
        let archived_thread = store.new_thread(first_project);
        let remaining_thread = store.new_thread(second_project);

        store.archive_or_delete_project(first_project, None);

        let projection = store.projection();
        assert!(
            !store
                .threads
                .iter()
                .any(|thread| thread.id == archived_thread)
        );
        assert!(
            store
                .threads
                .iter()
                .any(|thread| thread.id == remaining_thread)
        );
        assert_eq!(projection.sidebar.total_thread_count, 1);
        assert_eq!(
            projection.sidebar.active_thread_id.as_ref(),
            Some(&remaining_thread)
        );
    }

    #[test]
    fn sidebar_projection_pages_loaded_threads() {
        let project_id = ProjectId::new();
        let project = Project {
            id: project_id,
            title: "Project".to_string(),
            workspace_root: "/tmp/project".to_string(),
            default_model_selection: None,
            scripts: Vec::new(),
            icon: None,
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            archived_at: None,
            deleted_at: None,
        };
        let threads = (0..12)
            .map(|index| ThreadSummary {
                id: ThreadId::new(),
                provider_thread_id: None,
                project_id,
                title: format!("Thread {index}"),
                status: ThreadStatus::Idle,
                provider: ace_core::ProviderKind::Codex,
                model: None,
                pinned: false,
                archived: false,
                unseen_completion: false,
                latest_activity_at: index.to_string(),
                latest_message_preview: None,
                pending_approvals: 0,
                pending_user_inputs: 0,
                has_actionable_plan: false,
                branch: None,
                worktree_path: None,
            })
            .collect::<Vec<_>>();

        let mut store = DesktopStore::new();
        store.replace_snapshot(
            vec![project],
            threads,
            HashMap::from([(project_id, 12usize)]),
        );
        assert_eq!(store.projection().sidebar.projects[0].threads.len(), 5);

        store.show_more_project_threads(project_id);
        assert_eq!(store.projection().sidebar.projects[0].threads.len(), 10);

        store.show_less_project_threads(project_id);
        assert_eq!(store.projection().sidebar.projects[0].threads.len(), 5);
    }
}
