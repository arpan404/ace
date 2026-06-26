use ace_error::{AceError, AceResult};
use std::{env, fs, path::PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppDirs {
    pub root_dir: PathBuf,
    pub state_dir: PathBuf,
    pub config_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub log_dir: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppPaths {
    Root,
    Logs,
    State,
    Config,
    Cache,
    UserData,
    UIStatePersistence,
    AceDb,
}

pub fn get_ace_base_dir() -> AceResult<PathBuf> {
    if let Ok(dir) = env::var("ACE_BASE_DIR") {
        return Ok(PathBuf::from(dir));
    }

    home::home_dir()
        .map(|home| home.join(".ace"))
        .ok_or_else(|| AceError::Config("failed to resolve home directory".into()))
}

pub fn ensure_dir(path: impl Into<PathBuf>) -> AceResult<PathBuf> {
    let path = path.into();
    fs::create_dir_all(&path)?;
    Ok(path)
}

pub fn create_dir_all(path: impl AsRef<std::path::Path>) -> AceResult<()> {
    Ok(fs::create_dir_all(path)?)
}

impl AppDirs {
    pub fn resolve() -> AceResult<Self> {
        let root_dir = AppPaths::Root.path()?;
        Ok(Self {
            state_dir: AppPaths::State.path()?,
            config_dir: AppPaths::Config.path()?,
            cache_dir: AppPaths::Cache.path()?,
            log_dir: AppPaths::Logs.path()?,
            root_dir,
        })
    }
}

impl AppPaths {
    pub fn path(self) -> AceResult<PathBuf> {
        let base = get_ace_base_dir()?;
        let path = match self {
            AppPaths::Root => base,
            AppPaths::Logs => base.join("logs"),
            AppPaths::State => base.join("state"),
            AppPaths::Config => base.join("config"),
            AppPaths::Cache => base.join("cache"),
            AppPaths::UserData => base.join("userdata"),
            AppPaths::UIStatePersistence => base.join("userdata").join("ui"),
            AppPaths::AceDb => base.join("userdata").join("state.sqlite"),
        };
        if matches!(self, AppPaths::AceDb) {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            Ok(path)
        } else {
            ensure_dir(path)
        }
    }
}
