//! Where Spade, the main bot, lives (ADR 0187): one record the person's machines share. Each
//! Spade keeps the newest record it has heard of and shows its main bot only while the record
//! names its own machine. Only the person and a move write a new one.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use spade_store::StoreError;

use super::super::Engine;

/// The settings key of the record this machine holds.
pub const MAIN_HOST: &str = "main_host";
/// Set while the person deliberately switched Spade's main bot off here.
pub const MAIN_OFF: &str = "main_off";
/// Written by the app's old election (`PUT /v1/main {"enabled": false}`), which no longer
/// runs: obeyed only until this machine hears a record, then dropped.
pub const MAIN_ENABLED: &str = "main_enabled";

/// Longest host id a record may name.
const HOST_CHARS: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostRecord {
    /// The machine's ace host id.
    pub host: String,
    pub version: u64,
    /// When it was chosen, in ms.
    pub at: i64,
    /// `person`, `seed` (the app's first record, naming the Spade it found) or `move`.
    #[serde(default)]
    pub by: String,
}

impl HostRecord {
    /// Whether this record replaces `other`: a higher version, then a later time, then the
    /// higher host id. Every machine orders two records the same way, so all keep the same one.
    pub fn newer_than(&self, other: &HostRecord) -> bool {
        (self.version, self.at, self.host.as_str()) > (other.version, other.at, other.host.as_str())
    }

    /// A record from outside (the app, another machine), checked.
    pub fn parse(value: &Value) -> Option<Self> {
        let record: HostRecord = serde_json::from_value(value.clone()).ok()?;
        let host_ok = !record.host.is_empty()
            && record.host.len() <= HOST_CHARS
            && record
                .host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'));
        let by_ok = matches!(record.by.as_str(), "person" | "seed" | "move");
        (host_ok && by_ok && record.version > 0).then_some(record)
    }

    pub fn to_json(&self) -> Value {
        json!({ "host": self.host, "version": self.version, "at": self.at, "by": self.by })
    }
}

/// Whether Spade's main bot is in use on the machine `here`, from its settings as `read` gives
/// them: the person hasn't switched it off there, and the host record names it (before any
/// record, the old switch is on). One rule, for the roster and for a move that would replace it.
pub(crate) fn main_active_with(read: &dyn Fn(&str) -> Option<String>, here: Option<&str>) -> bool {
    if read(MAIN_OFF).is_some() {
        return false;
    }
    let record = read(MAIN_HOST)
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| HostRecord::parse(&value));
    match (record, here) {
        (Some(record), Some(here)) => record.host == here,
        _ => read(MAIN_ENABLED).as_deref() != Some("false"),
    }
}

impl Engine {
    /// This machine's host id, as ace's home says it.
    pub fn here(&self) -> Option<String> {
        self.remote().and_then(|remote| remote.host())
    }

    /// The record this machine holds, if it has heard one.
    pub fn host_record(&self) -> Result<Option<HostRecord>, StoreError> {
        Ok(self
            .store
            .setting(MAIN_HOST)?
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| HostRecord::parse(&value)))
    }

    /// Keeps `record` when it is newer than the one held; answers the one held after. The first
    /// record heard drops the old election's switch-off here, once.
    pub fn offer_host(&self, record: &HostRecord) -> Result<HostRecord, StoreError> {
        let _held = self.agent_lock.lock().unwrap_or_else(|p| p.into_inner());
        let held = self.host_record()?;
        match held {
            Some(held) if !record.newer_than(&held) => Ok(held),
            _ => {
                self.store
                    .set_setting(MAIN_HOST, Some(&record.to_json().to_string()))?;
                self.store.set_setting(MAIN_ENABLED, None)?;
                Ok(record.clone())
            }
        }
    }

    /// Whether Spade's main bot shows on this machine: the person hasn't switched it off here,
    /// and the record names this machine (or, before any record, the old switch is on).
    pub fn main_enabled(&self) -> Result<bool, StoreError> {
        let read = |key: &str| match self.store.setting(key) {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(%error, "a setting for Spade's host couldn't be read");
                None
            }
        };
        Ok(main_active_with(&read, self.here().as_deref()))
    }

    /// `PUT /v1/main`. From the person (`by: "person"`), a switch they keep until they turn it
    /// back on; without it, the old election's switch, which only counts before a record.
    pub fn set_main_enabled(&self, enabled: bool, by_person: bool) -> Result<(), StoreError> {
        if by_person {
            return self.store.set_setting(MAIN_OFF, (!enabled).then_some("1"));
        }
        if self.host_record()?.is_some() {
            return Ok(());
        }
        self.store
            .set_setting(MAIN_ENABLED, (!enabled).then_some("false"))
    }

    /// `GET /v1/main`.
    pub fn main_json(&self) -> Result<Value, StoreError> {
        Ok(json!({
            "here": self.here(),
            "host": self.host_record()?.map(|r| r.to_json()),
            "shown": self.main_enabled()?,
            "off": self.store.setting(MAIN_OFF)?.is_some(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::HostRecord;

    fn record(host: &str, version: u64, at: i64) -> HostRecord {
        HostRecord {
            host: host.to_owned(),
            version,
            at,
            by: "person".to_owned(),
        }
    }

    #[test]
    fn a_higher_version_wins_whatever_its_time_and_ties_fall_to_time_then_host() {
        assert!(record("a", 2, 1).newer_than(&record("b", 1, 99)));
        assert!(!record("b", 1, 99).newer_than(&record("a", 2, 1)));
        assert!(record("a", 1, 5).newer_than(&record("b", 1, 4)));
        assert!(record("b", 1, 5).newer_than(&record("a", 1, 5)));
        assert!(!record("a", 1, 5).newer_than(&record("a", 1, 5)));
    }

    #[test]
    fn a_record_with_an_odd_host_or_author_is_refused() {
        let ok = serde_json::json!({ "host": "host-1", "version": 1, "at": 1, "by": "seed" });
        assert!(HostRecord::parse(&ok).is_some());
        for bad in [
            serde_json::json!({ "host": "", "version": 1, "at": 1, "by": "seed" }),
            serde_json::json!({ "host": "a b", "version": 1, "at": 1, "by": "seed" }),
            serde_json::json!({ "host": "h", "version": 0, "at": 1, "by": "seed" }),
            serde_json::json!({ "host": "h", "version": 1, "at": 1, "by": "app" }),
        ] {
            assert!(HostRecord::parse(&bad).is_none(), "{bad}");
        }
    }
}
