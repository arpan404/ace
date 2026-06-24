use ace_core::Project;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiThread {
    pub id: String,
    pub title: String,
    pub updated: String,
    pub project_root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiMessage {
    pub id: String,
    pub role: MessageRole,
    pub text: String,
    pub pending: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusedField {
    Composer,
    ProjectPath,
}

#[derive(Debug, Clone)]
pub struct ShellState {
    pub projects: Vec<Project>,
    pub threads: Vec<UiThread>,
    pub messages: Vec<UiMessage>,
    pub selected_thread_id: Option<String>,
    pub selected_project_root: Option<String>,
    pub composer_text: String,
    pub project_path_text: String,
    pub focused_field: FocusedField,
    pub is_loading: bool,
    pub is_sending: bool,
    pub status: String,
    pub error: Option<String>,
}

impl Default for ShellState {
    fn default() -> Self {
        Self {
            projects: Vec::new(),
            threads: Vec::new(),
            messages: Vec::new(),
            selected_thread_id: None,
            selected_project_root: None,
            composer_text: String::new(),
            project_path_text: String::new(),
            focused_field: FocusedField::Composer,
            is_loading: false,
            is_sending: false,
            status: "Connecting".to_owned(),
            error: None,
        }
    }
}

impl ShellState {
    pub fn set_projects(&mut self, projects: Vec<Project>) {
        if self.selected_project_root.is_none() {
            self.selected_project_root = projects
                .first()
                .map(|project| project.workspace_root.clone());
        }
        self.projects = projects;
    }

    pub fn set_threads_from_value(&mut self, value: &Value) {
        self.threads = extract_threads(value);
        if self.selected_thread_id.is_none() {
            self.selected_thread_id = self.threads.first().map(|thread| thread.id.clone());
        }
    }

    pub fn select_thread(&mut self, thread_id: String) {
        self.selected_thread_id = Some(thread_id);
        self.messages.clear();
    }

    pub fn select_project(&mut self, root: String) {
        self.selected_project_root = Some(root);
    }

    pub fn apply_thread_read(&mut self, value: &Value) {
        self.messages = extract_messages(value);
    }

    pub fn push_user_message(&mut self, text: String) {
        let id = format!("local-user-{}", self.messages.len() + 1);
        self.messages.push(UiMessage {
            id,
            role: MessageRole::User,
            text,
            pending: true,
        });
    }

    pub fn mark_messages_sent(&mut self) {
        for message in &mut self.messages {
            message.pending = false;
        }
    }

    pub fn upsert_thread(&mut self, thread: UiThread) {
        if let Some(existing) = self.threads.iter_mut().find(|entry| entry.id == thread.id) {
            *existing = thread;
        } else {
            self.threads.insert(0, thread);
        }
    }
}

pub fn extract_thread_id(value: &Value) -> Option<String> {
    string_at(value, &["id"])
        .or_else(|| string_at(value, &["thread_id"]))
        .or_else(|| string_at(value, &["threadId"]))
        .or_else(|| string_at(value, &["thread", "id"]))
        .or_else(|| string_at(value, &["thread", "threadId"]))
}

fn extract_threads(value: &Value) -> Vec<UiThread> {
    let array = value
        .get("threads")
        .and_then(Value::as_array)
        .or_else(|| value.get("items").and_then(Value::as_array))
        .or_else(|| value.as_array());
    let Some(array) = array else {
        return Vec::new();
    };

    array
        .iter()
        .filter_map(|entry| {
            let id = extract_thread_id(entry)?;
            let title = string_at(entry, &["title"])
                .or_else(|| string_at(entry, &["name"]))
                .or_else(|| string_at(entry, &["metadata", "title"]))
                .unwrap_or_else(|| "New chat".to_owned());
            let updated = string_at(entry, &["updatedAt"])
                .or_else(|| string_at(entry, &["updated_at"]))
                .map(|_| "now".to_owned())
                .unwrap_or_else(|| "recent".to_owned());
            let project_root =
                string_at(entry, &["cwd"]).or_else(|| string_at(entry, &["metadata", "cwd"]));
            Some(UiThread {
                id,
                title,
                updated,
                project_root,
            })
        })
        .take(80)
        .collect()
}

fn extract_messages(value: &Value) -> Vec<UiMessage> {
    let array = value
        .get("messages")
        .and_then(Value::as_array)
        .or_else(|| {
            value
                .get("thread")
                .and_then(|thread| thread.get("messages"))
                .and_then(Value::as_array)
        })
        .or_else(|| value.get("items").and_then(Value::as_array));
    let Some(array) = array else {
        return Vec::new();
    };

    array
        .iter()
        .filter_map(|entry| {
            let text = string_at(entry, &["text"])
                .or_else(|| string_at(entry, &["content"]))
                .or_else(|| string_at(entry, &["message", "text"]))?;
            if text.trim().is_empty() {
                return None;
            }
            let role = match string_at(entry, &["role"]).as_deref() {
                Some("user") => MessageRole::User,
                Some("system") => MessageRole::System,
                _ => MessageRole::Assistant,
            };
            Some(UiMessage {
                id: string_at(entry, &["id"]).unwrap_or_else(|| format!("message-{}", text.len())),
                role,
                text,
                pending: false,
            })
        })
        .take(200)
        .collect()
}

fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_thread_ids_from_common_shapes() {
        assert_eq!(
            extract_thread_id(&json!({"thread_id": "a"})).as_deref(),
            Some("a")
        );
        assert_eq!(
            extract_thread_id(&json!({"thread": {"id": "b"}})).as_deref(),
            Some("b")
        );
    }

    #[test]
    fn caps_threads_and_messages_for_sidebar_rendering() {
        let value = json!({
            "threads": (0..120).map(|index| json!({"id": format!("t-{index}"), "title": "chat"})).collect::<Vec<_>>()
        });
        let mut state = ShellState::default();
        state.set_threads_from_value(&value);
        assert_eq!(state.threads.len(), 80);
    }
}
