use crate::{
    backend::{BackendError, DesktopBackend},
    shell_regions,
    state::{FocusedField, ShellState, UiThread, extract_thread_id},
    theme::colors,
};
use ace_core::Project;
use ace_protocol::{
    project::{ProjectAddRequest, ProjectListRequest},
    ws::methods,
};
use gpui::{
    App, AppContext, Context, FocusHandle, InteractiveElement, IntoElement, KeyDownEvent,
    ParentElement, Render, Styled, Window, div, px, rgb,
};
use serde_json::json;

pub const APP_TITLE: &str = "Ace";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellViewModel {
    pub title: String,
    pub workspace_name: String,
    pub branch_name: String,
    pub status: String,
}

impl Default for ShellViewModel {
    fn default() -> Self {
        Self {
            title: APP_TITLE.to_owned(),
            workspace_name: "t3code".to_owned(),
            branch_name: "rust-port".to_owned(),
            status: "Backend ready".to_owned(),
        }
    }
}

pub struct AppShell {
    model: ShellViewModel,
    backend: DesktopBackend,
    state: ShellState,
    composer_focus: FocusHandle,
    project_focus: FocusHandle,
}

impl AppShell {
    pub fn new(model: ShellViewModel, backend: DesktopBackend, cx: &mut Context<Self>) -> Self {
        Self {
            model,
            backend,
            state: ShellState::default(),
            composer_focus: cx.focus_handle(),
            project_focus: cx.focus_handle(),
        }
    }

    pub(crate) fn state(&self) -> &ShellState {
        &self.state
    }

    pub(crate) fn composer_focus(&self) -> FocusHandle {
        self.composer_focus.clone()
    }

    pub(crate) fn project_focus(&self) -> FocusHandle {
        self.project_focus.clone()
    }

    pub(crate) fn focus_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.state.focused_field = FocusedField::Composer;
        window.focus(&self.composer_focus);
        cx.notify();
    }

    pub(crate) fn focus_project_path(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.state.focused_field = FocusedField::ProjectPath;
        window.focus(&self.project_focus);
        cx.notify();
    }

    pub(crate) fn select_project(&mut self, root: String, cx: &mut Context<Self>) {
        self.state.select_project(root);
        cx.notify();
    }

    pub(crate) fn select_thread(&mut self, thread_id: String, cx: &mut Context<Self>) {
        self.state.select_thread(thread_id.clone());
        self.read_thread(thread_id, cx);
        cx.notify();
    }

    pub(crate) fn create_thread(&mut self, cx: &mut Context<Self>) {
        self.state.is_loading = true;
        self.state.status = "Creating thread".to_owned();
        self.state.error = None;
        let backend = self.backend.clone();
        let cwd = self.state.selected_project_root.clone();
        cx.spawn(async move |this: gpui::WeakEntity<AppShell>, cx| {
            let payload = json!({
                "cwd": cwd,
                "model": "gpt-5.5",
                "approvalPolicy": {"preset": "on-request"}
            });
            let result = backend
                .rpc_value_task(methods::CODEX_THREAD_START, payload)
                .await
                .unwrap_or_else(|error| Err(BackendError::join(error)));
            this.update(cx, |this, cx| {
                this.state.is_loading = false;
                match result {
                    Ok(value) => {
                        if let Some(thread_id) = extract_thread_id(&value) {
                            this.state.selected_thread_id = Some(thread_id.clone());
                            this.state.upsert_thread(UiThread {
                                id: thread_id,
                                title: "New chat".to_owned(),
                                updated: "now".to_owned(),
                                project_root: this.state.selected_project_root.clone(),
                            });
                            this.state.messages.clear();
                            this.state.status = "Thread ready".to_owned();
                        } else {
                            this.state.error =
                                Some("Thread response did not include an id".to_owned());
                        }
                    }
                    Err(error) => this.state.error = Some(error.display()),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn add_project(&mut self, cx: &mut Context<Self>) {
        let workspace_root = self.state.project_path_text.trim().to_owned();
        if workspace_root.is_empty() {
            self.state.error = Some("Enter a project path first".to_owned());
            cx.notify();
            return;
        }
        self.state.is_loading = true;
        self.state.error = None;
        let backend = self.backend.clone();
        cx.spawn(async move |this: gpui::WeakEntity<AppShell>, cx| {
            let request = ProjectAddRequest {
                workspace_root,
                title: None,
                default_model_selection: None,
            };
            let result = backend
                .rpc_task::<_, Project>(methods::PROJECTS_ADD, request)
                .await
                .unwrap_or_else(|error| Err(BackendError::join(error)));
            this.update(cx, |this, cx| {
                this.state.is_loading = false;
                match result {
                    Ok(project) => {
                        this.state.selected_project_root = Some(project.workspace_root.clone());
                        this.state.project_path_text.clear();
                        this.state.projects.insert(0, project);
                        this.state.status = "Project added".to_owned();
                    }
                    Err(error) => this.state.error = Some(error.display()),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn send_message(&mut self, cx: &mut Context<Self>) {
        let prompt = self.state.composer_text.trim().to_owned();
        if prompt.is_empty() || self.state.is_sending {
            return;
        }
        let Some(thread_id) = self.state.selected_thread_id.clone() else {
            self.create_thread(cx);
            return;
        };
        self.state.composer_text.clear();
        self.state.push_user_message(prompt.clone());
        self.state.is_sending = true;
        self.state.error = None;
        let backend = self.backend.clone();
        cx.spawn(async move |this: gpui::WeakEntity<AppShell>, cx| {
            let payload = json!({
                "thread_id": thread_id,
                "prompt": prompt,
                "model": "gpt-5.5",
            });
            let result = backend
                .rpc_value_task(methods::CODEX_TURN_START, payload)
                .await
                .unwrap_or_else(|error| Err(BackendError::join(error)));
            this.update(cx, |this, cx| {
                this.state.is_sending = false;
                match result {
                    Ok(_) => {
                        this.state.mark_messages_sent();
                        this.state.status = "Message sent".to_owned();
                    }
                    Err(error) => this.state.error = Some(error.display()),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn handle_text_key(
        &mut self,
        event: &KeyDownEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if event.keystroke.modifiers.platform || event.keystroke.modifiers.control {
            return;
        }
        let target = match self.state.focused_field {
            FocusedField::Composer => &mut self.state.composer_text,
            FocusedField::ProjectPath => &mut self.state.project_path_text,
        };
        match event.keystroke.key.as_str() {
            "backspace" => {
                target.pop();
            }
            "enter" => {
                if self.state.focused_field == FocusedField::Composer {
                    self.send_message(cx);
                } else {
                    self.add_project(cx);
                }
                return;
            }
            _ => {
                if let Some(text) = &event.keystroke.key_char
                    && !text.chars().any(char::is_control)
                {
                    target.push_str(text);
                }
            }
        }
        cx.notify();
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.state.is_loading = true;
        let backend = self.backend.clone();
        cx.spawn(async move |this: gpui::WeakEntity<AppShell>, cx| {
            let projects = backend
                .rpc_task::<_, Vec<Project>>(methods::PROJECTS_LIST, ProjectListRequest {})
                .await
                .unwrap_or_else(|error| Err(BackendError::join(error)));
            let threads = backend
                .rpc_value_task(methods::CODEX_THREADS_LIST, json!({ "limit": 80 }))
                .await
                .unwrap_or_else(|error| Err(BackendError::join(error)));
            this.update(cx, |this, cx| {
                this.state.is_loading = false;
                match projects {
                    Ok(projects) => this.state.set_projects(projects),
                    Err(error) => this.state.error = Some(error.display()),
                }
                match threads {
                    Ok(value) => this.state.set_threads_from_value(&value),
                    Err(error) => {
                        if this.state.error.is_none() {
                            this.state.error = Some(error.display());
                        }
                    }
                }
                this.state.status = "Ready".to_owned();
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn read_thread(&mut self, thread_id: String, cx: &mut Context<Self>) {
        let backend = self.backend.clone();
        cx.spawn(async move |this: gpui::WeakEntity<AppShell>, cx| {
            let result = backend
                .rpc_value_task(
                    methods::CODEX_THREAD_READ,
                    json!({ "thread_id": thread_id }),
                )
                .await
                .unwrap_or_else(|error| Err(BackendError::join(error)));
            this.update(cx, |this, cx| {
                match result {
                    Ok(value) => this.state.apply_thread_read(&value),
                    Err(error) => this.state.error = Some(error.display()),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

impl Render for AppShell {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("ace-root")
            .size_full()
            .flex()
            .bg(rgb(colors::APP))
            .text_color(rgb(colors::TEXT))
            .text_size(px(16.0))
            .on_key_down(cx.listener(Self::handle_text_key))
            .child(shell_regions::sidebar(self, cx))
            .child(shell_regions::workbench(&self.model, self, cx))
    }
}

pub fn app_shell(
    model: ShellViewModel,
    backend: DesktopBackend,
    cx: &mut App,
) -> gpui::Entity<AppShell> {
    cx.new(|cx| {
        let mut shell = AppShell::new(model, backend, cx);
        shell.refresh(cx);
        shell
    })
}
