use super::{
    DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ID, DEFAULT_TERMINAL_ROWS,
    DESKTOP_TERMINAL_HISTORY_LIMIT, TerminalSessionProjection,
};
use ace_core::ThreadId;
use ace_protocol::terminal::{TerminalSessionSnapshot, TerminalSessionStatus};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct TerminalKey {
    pub(super) thread_id: String,
    pub(super) terminal_id: String,
}

impl TerminalKey {
    pub(super) fn default_for_thread(thread_id: &ThreadId) -> Self {
        Self {
            thread_id: thread_id.0.clone(),
            terminal_id: DEFAULT_TERMINAL_ID.to_string(),
        }
    }
}

impl TerminalSessionProjection {
    pub(super) fn from_snapshot(snapshot: TerminalSessionSnapshot) -> Self {
        let mut history = snapshot.history;
        trim_terminal_history(&mut history);
        Self {
            thread_id: snapshot.thread_id,
            terminal_id: snapshot.terminal_id,
            cwd: snapshot.cwd,
            title: snapshot.title,
            status: snapshot.status,
            pid: snapshot.pid,
            history,
            exit_code: snapshot.exit_code,
            exit_signal: snapshot.exit_signal,
            cols: snapshot.cols,
            rows: snapshot.rows,
            updated_at: snapshot.updated_at,
            next_sequence: snapshot.next_sequence,
            truncated_before_sequence: snapshot.truncated_before_sequence,
        }
    }

    pub(super) fn placeholder(thread_id: String, terminal_id: String) -> Self {
        Self {
            thread_id,
            terminal_id,
            cwd: String::new(),
            title: None,
            status: TerminalSessionStatus::Running,
            pid: None,
            history: String::new(),
            exit_code: None,
            exit_signal: None,
            cols: DEFAULT_TERMINAL_COLS,
            rows: DEFAULT_TERMINAL_ROWS,
            updated_at: String::new(),
            next_sequence: 0,
            truncated_before_sequence: None,
        }
    }
}

pub(super) fn short_status(status: &TerminalSessionStatus) -> &'static str {
    match status {
        TerminalSessionStatus::Starting => "starting",
        TerminalSessionStatus::Running => "running",
        TerminalSessionStatus::Exited => "exited",
        TerminalSessionStatus::Error => "error",
    }
}

pub(super) fn append_terminal_history(history: &mut String, data: &str) {
    history.push_str(data);
    trim_terminal_history(history);
}

fn trim_terminal_history(history: &mut String) {
    if history.len() <= DESKTOP_TERMINAL_HISTORY_LIMIT {
        return;
    }

    let trim_to = history.len() - DESKTOP_TERMINAL_HISTORY_LIMIT;
    let split = history[trim_to..]
        .find('\n')
        .map(|offset| trim_to + offset + 1)
        .unwrap_or(trim_to);
    history.drain(..split);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_key_uses_default_terminal_id() {
        let thread_id = ThreadId::new();
        let key = TerminalKey::default_for_thread(&thread_id);

        assert_eq!(key.thread_id, thread_id.0);
        assert_eq!(key.terminal_id, DEFAULT_TERMINAL_ID);
    }

    #[test]
    fn terminal_history_is_bounded_on_line_boundary_when_possible() {
        let mut history = format!(
            "old line\n{}",
            "x".repeat(DESKTOP_TERMINAL_HISTORY_LIMIT + 16)
        );
        append_terminal_history(&mut history, "\nnew");

        assert!(history.len() <= DESKTOP_TERMINAL_HISTORY_LIMIT + "\nnew".len());
        assert!(!history.starts_with("old line"));
    }
}
