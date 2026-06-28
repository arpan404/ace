pub mod desktop;
pub mod ui;

pub use desktop::{
    DesktopProjection, DesktopStore, ReviewFileProjection, ReviewProjection, ServiceReadiness,
    ServiceStatus, SourceItemProjection, ThreadAnnotationsProjection, ThreadAnnotationsSnapshot,
    TodoItem, TodoStatus, ToolRegistryEntryProjection, ToolRegistryProjection,
};
pub use ui::UiStore;
