mod error;
mod json;
mod migration;
mod projection;

pub use error::PersistenceError;
pub use migration::{migrate, open_event_store};
pub use projection::ProjectionRepository;
