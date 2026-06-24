mod chat;
mod terminal;

use crate::shell::{AppShell, ShellViewModel};
use gpui::{AnyElement, Context};

pub(super) fn chat_workspace(shell: &AppShell, cx: &mut Context<AppShell>) -> AnyElement {
    chat::chat_workspace(shell, cx)
}

pub(super) fn terminal_panel(model: &ShellViewModel) -> AnyElement {
    terminal::terminal_panel(model)
}
