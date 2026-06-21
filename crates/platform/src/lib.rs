use directories::ProjectDirs;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    pub state_dir: PathBuf,
    pub config_dir: PathBuf,
    pub cache_dir: PathBuf,
}

impl AppPaths {
    pub fn resolve() -> Result<Self, PlatformError> {
        let dirs = ProjectDirs::from("dev", "ace", "ace").ok_or(PlatformError::ProjectDirs)?;
        Ok(Self {
            state_dir: dirs.data_local_dir().to_path_buf(),
            config_dir: dirs.config_dir().to_path_buf(),
            cache_dir: dirs.cache_dir().to_path_buf(),
        })
    }
}

#[derive(Debug, Error)]
pub enum PlatformError {
    #[error("could not resolve platform project directories")]
    ProjectDirs,
}
