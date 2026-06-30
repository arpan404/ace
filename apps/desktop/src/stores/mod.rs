pub mod desktop;
pub mod ui;

pub use desktop::{
    ApprovalItemProjection, ApprovalRegistryProjection, BrowserActivityProjection,
    BrowserBridgeProjection, BrowserPreviewProjection, BrowserProjection,
    ComposerCommandProjection, ComposerCommandSource, DesktopProjection, DesktopStore,
    EditorFileProjection, EditorProjection, HostOptionProjection, ModelProjection,
    ModelProviderProjection, ModelRegistryProjection, ProviderSlashCommandProjection,
    ReviewCommentItem, ReviewFileProjection, ReviewProjection, RunProjection, SearchContextKind,
    ServiceReadiness, ServiceStatus, SourceItemProjection, SummaryProjection,
    ThreadAnnotationsProjection, ThreadAnnotationsSnapshot, TodoAssignee, TodoItem, TodoPriority,
    TodoStatus, ToolRegistryEntryProjection, ToolRegistryProjection, WorktreeEntryProjection,
    WorktreeProjection,
};
pub use ui::UiStore;
