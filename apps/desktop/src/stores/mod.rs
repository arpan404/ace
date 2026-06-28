pub mod desktop;
pub mod ui;

pub use desktop::{
    DesktopProjection, DesktopStore, ReviewFileProjection, ReviewProjection, ServiceReadiness,
    ServiceStatus, ThreadAnnotationsProjection, ThreadAnnotationsSnapshot, TodoStatus,
};
pub use ui::UiStore;
