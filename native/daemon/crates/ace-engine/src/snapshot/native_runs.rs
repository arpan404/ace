// SPDX-License-Identifier: Apache-2.0
//! The `nativeRuns:<agentKey>` sections (`persistence.ts:50`-`:60`): an agent's stored
//! `nativeRuns` live in their own section, so the agents section stores `nativeRuns: {}`.

use std::sync::Arc;

use indexmap::IndexMap;

use super::Snapshot;
use super::decode;
use super::sections;
use super::spec;
use crate::EngineError;
use crate::records::{self, Records};

impl Snapshot {
    pub(crate) fn native_runs(
        &mut self,
        key: &str,
    ) -> Result<IndexMap<String, String>, EngineError> {
        let name = sections::native_runs(key);
        if !self.native_runs.contains_key(key) {
            let cache = records::section(&self.budget);
            let mut dictionary = Records::new(
                Arc::clone(&self.conn),
                &self.budget,
                self.state.thread_id.clone(),
                spec(&name, decode::decode_record::<String>, cache),
                IndexMap::new(),
                None,
                None,
            );
            if self.released {
                dictionary.release();
            }
            self.native_runs.insert(key.to_owned(), dictionary);
        }
        let Some(dictionary) = self.native_runs.get_mut(key) else {
            return Ok(IndexMap::new());
        };
        let mut runs = IndexMap::new();
        for run_key in dictionary.keys()? {
            if let Some(run_id) = dictionary.read(&run_key)? {
                runs.insert(run_key, run_id);
            }
        }
        Ok(runs)
    }

    /// Write only the agents this batch changed: `encode` runs per touched record, as the
    /// TypeScript's does, so the section is never rewritten whole.
    pub(super) fn sync_native_runs(&mut self) -> Result<(), EngineError> {
        let changed: Vec<String> = self
            .agents
            .changes()
            .into_iter()
            .filter_map(|(key, change)| {
                matches!(change, ace_core::section::Change::Written(_)).then_some(key)
            })
            .collect();
        for key in changed {
            let Some(runs) = self
                .state
                .agents
                .get(&key)
                .and_then(|record| record.native_runs.clone())
            else {
                continue;
            };
            if !self.native_runs.contains_key(&key) {
                self.native_runs(&key)?;
            }
            if let Some(dictionary) = self.native_runs.get_mut(&key) {
                for (run_key, run_id) in runs {
                    dictionary.write(&run_key, run_id);
                }
            }
        }
        Ok(())
    }
}
