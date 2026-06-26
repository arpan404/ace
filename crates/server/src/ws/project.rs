use super::{WsApiState, WsDispatchError};
use ace_git::ProcessRunner;
use ace_persistence::{
    load_default_ace_db, load_default_project_threads, load_default_thread_messages,
};
use ace_protocol::{
    project::{
        ProjectAddRequest, ProjectCreateEntryRequest, ProjectCwdRequest, ProjectDeleteRequest,
        ProjectEntryPathRequest, ProjectListRequest, ProjectRenameEntryRequest,
        ProjectSearchEntriesRequest, ProjectSnapshotRequest, ProjectSnapshotResponse,
        ProjectThreadsRequest, ProjectUpdateRequest, ProjectWriteFileRequest,
        ThreadMessagesRequest, ThreadMessagesResponse,
    },
    ws::methods,
};
use ace_terminal::PtyAdapter;
use serde_json::Value;

impl<R: ProcessRunner, A: PtyAdapter> WsApiState<R, A> {
    pub(super) async fn dispatch_project_method(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, WsDispatchError> {
        match method {
            methods::PROJECTS_LIST => {
                self.project_json::<ProjectListRequest, _, _, _>(
                    payload,
                    |service, _request| async move { service.list().await },
                )
                .await
            }
            methods::PROJECTS_SNAPSHOT => {
                serde_json::from_value::<ProjectSnapshotRequest>(payload)?;
                let snapshot = load_default_ace_db()?;
                Ok(serde_json::to_value(ProjectSnapshotResponse {
                    projects: snapshot.projects,
                    threads: snapshot.threads,
                    thread_counts: snapshot.thread_counts,
                })?)
            }
            methods::PROJECTS_PROJECT_THREADS => {
                let request = serde_json::from_value::<ProjectThreadsRequest>(payload)?;
                Ok(serde_json::to_value(load_default_project_threads(
                    request.project_id,
                    request.limit,
                )?)?)
            }
            methods::PROJECTS_THREAD_MESSAGES => {
                let request = serde_json::from_value::<ThreadMessagesRequest>(payload)?;
                Ok(serde_json::to_value(ThreadMessagesResponse {
                    messages: load_default_thread_messages(&request.thread_id, request.limit)?,
                })?)
            }
            methods::PROJECTS_ADD => {
                self.project_json::<ProjectAddRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.add(request).await },
                )
                .await
            }
            methods::PROJECTS_UPDATE => {
                self.project_json::<ProjectUpdateRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.update(request).await },
                )
                .await
            }
            methods::PROJECTS_DELETE => {
                self.project_json::<ProjectDeleteRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.delete(request).await },
                )
                .await
            }
            methods::PROJECTS_SEARCH_ENTRIES => {
                self.project_json::<ProjectSearchEntriesRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.search_entries(request).await },
                )
                .await
            }
            methods::PROJECTS_LIST_TREE => {
                self.project_json::<ProjectCwdRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.list_tree(request).await },
                )
                .await
            }
            methods::PROJECTS_RESOLVE_FAVICON => {
                self.project_json::<ProjectCwdRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.resolve_favicon(request).await },
                )
                .await
            }
            methods::PROJECTS_CREATE_ENTRY => {
                self.project_json::<ProjectCreateEntryRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.create_entry(request).await },
                )
                .await
            }
            methods::PROJECTS_DELETE_ENTRY => {
                self.project_json::<ProjectEntryPathRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.delete_entry(request).await },
                )
                .await
            }
            methods::PROJECTS_READ_FILE => {
                self.project_json::<ProjectEntryPathRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.read_file(request).await },
                )
                .await
            }
            methods::PROJECTS_RENAME_ENTRY => {
                self.project_json::<ProjectRenameEntryRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.rename_entry(request).await },
                )
                .await
            }
            methods::PROJECTS_WRITE_FILE => {
                self.project_json::<ProjectWriteFileRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.write_file(request).await },
                )
                .await
            }
            _ => Err(WsDispatchError::UnknownMethod(method.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{git::GitService, github::GithubService, project::ProjectService};
    use ace_git::{
        CommandOutput, CommandRequest, GitClient, GitToolError, GithubCliClient, ProcessRunner,
    };
    use ace_project::ProjectRegistry;
    use ace_protocol::{
        PROTOCOL_VERSION,
        ws::{WsServerPayload, WsServerResponse},
    };
    use async_trait::async_trait;
    use rusqlite::Connection;
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };

    #[derive(Debug)]
    struct FakeRunner {
        outputs: Mutex<VecDeque<CommandOutput>>,
    }

    #[async_trait]
    impl ProcessRunner for FakeRunner {
        async fn run(&self, _request: CommandRequest) -> ace_git::Result<CommandOutput> {
            self.outputs
                .lock()
                .expect("lock outputs")
                .pop_front()
                .ok_or_else(|| GitToolError::Parse {
                    context: "fake project runner",
                    message: "no fake output queued".to_string(),
                })
        }
    }

    fn test_state() -> WsApiState<FakeRunner> {
        let runner = Arc::new(FakeRunner {
            outputs: Mutex::new(VecDeque::new()),
        });
        let registry = ProjectRegistry::from_connection(Connection::open_in_memory().expect("db"))
            .expect("registry");
        WsApiState::new_services(
            GitService::new_with_github(
                GitClient::with_runner(runner.clone()),
                GithubCliClient::with_runner(runner.clone()),
            ),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_project_service(ProjectService::with_registry(registry))
    }

    async fn dispatch(
        state: &WsApiState<FakeRunner>,
        request: serde_json::Value,
    ) -> WsServerResponse {
        let response = state.dispatch_text(&request.to_string()).await;
        serde_json::from_str(&response).expect("response")
    }

    #[tokio::test]
    async fn dispatches_project_registry_files_and_favicon_over_ws_rpc() {
        let workspace = tempfile::tempdir().expect("workspace");
        std::fs::create_dir_all(workspace.path().join("public/brand")).expect("mkdir");
        std::fs::write(
            workspace.path().join("index.html"),
            "<link rel=\"icon\" href=\"/brand/logo.svg\">",
        )
        .expect("html");
        std::fs::write(workspace.path().join("public/brand/logo.svg"), "<svg />").expect("svg");
        std::fs::write(workspace.path().join("README.md"), "hello\n").expect("readme");
        let state = test_state();

        let add = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "project-add",
                "method": methods::PROJECTS_ADD,
                "payload": {
                    "workspace_root": workspace.path(),
                    "title": "Workspace",
                    "default_model_selection": null
                }
            }),
        )
        .await;
        let tree = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "project-tree",
                "method": methods::PROJECTS_LIST_TREE,
                "payload": { "cwd": workspace.path() }
            }),
        )
        .await;
        let read = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "project-read",
                "method": methods::PROJECTS_READ_FILE,
                "payload": {
                    "cwd": workspace.path(),
                    "relative_path": "README.md"
                }
            }),
        )
        .await;
        let favicon = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "project-favicon",
                "method": methods::PROJECTS_RESOLVE_FAVICON,
                "payload": { "cwd": workspace.path() }
            }),
        )
        .await;

        let WsServerPayload::Result { body: add } = add.payload else {
            panic!("expected project add result");
        };
        let WsServerPayload::Result { body: tree } = tree.payload else {
            panic!("expected project tree result");
        };
        let WsServerPayload::Result { body: read } = read.payload else {
            panic!("expected project read result");
        };
        let WsServerPayload::Result { body: favicon } = favicon.payload else {
            panic!("expected project favicon result");
        };

        assert_eq!(add["status"], "created");
        assert!(
            tree["entries"]
                .as_array()
                .expect("entries")
                .iter()
                .any(|entry| entry["path"] == "README.md")
        );
        assert_eq!(read["contents"], "hello\n");
        assert!(
            favicon["path"]
                .as_str()
                .expect("favicon path")
                .ends_with("public/brand/logo.svg")
        );
    }
}
