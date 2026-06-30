pub mod desktop;
pub mod ui;

pub use desktop::{
    ApprovalItemProjection, ApprovalRegistryProjection, DesktopProjection, DesktopStore,
    HostOptionProjection, ModelProjection, ModelProviderProjection, ModelRegistryProjection,
    ProviderSlashCommandProjection, ReviewCommentItem, ReviewFileProjection, ReviewProjection,
    ServiceReadiness, ServiceStatus, SourceItemProjection, ThreadAnnotationsProjection,
    ThreadAnnotationsSnapshot, TodoItem, TodoStatus, ToolRegistryEntryProjection,
    ToolRegistryProjection, WorktreeEntryProjection, WorktreeProjection,
};
pub use ui::UiStore;
