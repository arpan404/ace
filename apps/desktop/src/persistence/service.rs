use crate::persistence::PersistenceStore;
use ace_error::AceResult;
use ace_fs::AppPaths;
use serde::{Serialize, de::DeserializeOwned};
use std::{fs, path::PathBuf};

#[derive(Clone, Debug)]
pub struct PersistenceService {
    root: PathBuf,
}

impl PersistenceService {
    pub fn ui_state() -> AceResult<Self> {
        Ok(Self {
            root: AppPaths::UIStatePersistence.path()?,
        })
    }

    fn path_for_key(&self, key: &str) -> PathBuf {
        self.root.join(format!("{key}.json"))
    }

    pub fn load_snapshot<T>(&self, key: &str) -> T
    where
        T: DeserializeOwned + Default,
    {
        let path = self.path_for_key(key);
        let Ok(raw) = fs::read_to_string(path) else {
            return T::default();
        };
        serde_json::from_str(&raw).unwrap_or_default()
    }

    pub fn save_snapshot<T>(&self, key: &str, snapshot: &T) -> AceResult<()>
    where
        T: Serialize,
    {
        let path = self.path_for_key(key);
        let tmp_path = path.with_extension("json.tmp");
        fs::write(&tmp_path, serde_json::to_vec_pretty(snapshot)?)?;
        fs::rename(&tmp_path, &path)?;
        Ok(())
    }

    pub fn load_store<S>(&self) -> S
    where
        S: PersistenceStore,
    {
        S::restore(self.load_snapshot(S::KEY))
    }

    pub fn save_store<S>(&self, store: &S) -> AceResult<()>
    where
        S: PersistenceStore,
    {
        self.save_snapshot(S::KEY, &store.snapshot())
    }
}
