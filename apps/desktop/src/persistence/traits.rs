use serde::{Serialize, de::DeserializeOwned};

pub trait PersistenceStore {
    type Snapshot: Serialize + DeserializeOwned + Default + Clone + 'static;
    const KEY: &'static str;

    fn snapshot(&self) -> Self::Snapshot;
    fn restore(snapshot: Self::Snapshot) -> Self;
}
