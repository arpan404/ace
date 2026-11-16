//! The helper as an ace-media producer (docs/media/plan.md, E1): encoded screen video as
//! MediaFrames on ace-media's ingest pipe, or as frame packets on the daemon's pipe, switched
//! with an exact boundary by `media-ingest`'s route. Everything here is pure, so it is tested
//! on any host; the named pipe, the pump thread and Media Foundation live in `crate::windows`.
pub mod annexb;
pub mod capability;
pub mod config;
pub mod connection;
pub mod pump;
pub mod shell;
