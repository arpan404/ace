// SPDX-License-Identifier: Apache-2.0
//! When an ACP agent's metadata-only probe may start (`acp-probe-gate.ts`).
//!
//! A probe opens a real session in the agent, and agents start the MCP servers their own
//! configuration names when one opens. So the person's own request always may; a read
//! may only for a reviewed profile reloading a row that loaded before; startup, timers
//! and `refresh` never do. Attempts stay spaced whatever asked, so a reset-and-read loop
//! cannot start an agent again and again.

use std::collections::BTreeMap;

use ace_models::instance::ModelProbe;

/// What started a refresh.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshCause {
    /// Restart, timers, version and setting changes, and every `refresh`.
    Background,
    /// A picker or `models` listing asked for the row.
    Read,
    /// The person asked for this row's models (Load models).
    Request,
}

/// What the catalog knows of an ACP row when it decides whether a probe may start.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AcpRowFacts {
    /// The row has a model list now.
    pub loaded: bool,
    /// The row loaded once in this run, so the agent already ran here.
    pub loaded_before: bool,
    /// A `refresh` or sign-in reset the row.
    pub due: bool,
}

/// Whether an ACP agent's row may open its probe session now.
pub fn acp_probe_allowed(
    config: Option<ModelProbe>,
    facts: AcpRowFacts,
    cause: RefreshCause,
) -> bool {
    let Some(probe) = config else {
        return false;
    };
    if cause == RefreshCause::Request {
        return true;
    }
    cause == RefreshCause::Read
        && probe == ModelProbe::Automatic
        && facts.loaded_before
        && (!facts.loaded || facts.due)
}

/// How the row reports its probe: an automatic agent that has not loaded yet waits for
/// the person, so the picker offers Load models.
pub fn reported_probe(config: Option<ModelProbe>, loaded_before: bool) -> Option<ModelProbe> {
    match (config, loaded_before) {
        (Some(ModelProbe::Automatic), false) => Some(ModelProbe::OnRequest),
        (probe, _) => probe,
    }
}

/// The earliest each ACP row's next probe may start.
#[derive(Debug, Clone)]
pub struct AcpProbeSpacing {
    started_at: BTreeMap<String, f64>,
    interval_ms: f64,
}

impl AcpProbeSpacing {
    /// A negative or non-finite interval is refused, as the TypeScript refuses it.
    pub fn new(interval_ms: f64) -> Result<Self, &'static str> {
        if !interval_ms.is_finite() || interval_ms < 0.0 {
            return Err("Invalid probe interval");
        }
        Ok(Self {
            started_at: BTreeMap::new(),
            interval_ms,
        })
    }

    /// Whether a probe of `id` may start at `now`; when it may, it counts as started.
    pub fn admit(&mut self, id: &str, now: f64) -> bool {
        if let Some(last) = self.started_at.get(id)
            && now - last < self.interval_ms
        {
            return false;
        }
        self.started_at.insert(id.to_owned(), now);
        true
    }

    pub fn forget(&mut self, id: &str) {
        self.started_at.remove(id);
    }
}

#[cfg(test)]
mod tests {
    //! Ports `packages/models/src/acp-probe-gate.ts` through the cases
    //! `acp-model-probe.process.test.ts` names: an unprofiled agent waits for the
    //! person, a reviewed profile loads on the first read only after it loaded once,
    //! `refresh` never probes, and attempts stay spaced.

    use super::*;

    #[test]
    fn only_the_persons_request_or_a_reviewed_reload_may_open_a_probe() {
        let automatic = Some(ModelProbe::Automatic);
        let loaded = AcpRowFacts {
            loaded: true,
            loaded_before: true,
            due: false,
        };
        assert!(!acp_probe_allowed(
            automatic,
            loaded,
            RefreshCause::Background
        ));
        assert!(!acp_probe_allowed(automatic, loaded, RefreshCause::Read));
        assert!(acp_probe_allowed(automatic, loaded, RefreshCause::Request));
        let due = AcpRowFacts {
            due: true,
            ..loaded
        };
        assert!(acp_probe_allowed(automatic, due, RefreshCause::Read));
        let never = AcpRowFacts::default();
        assert!(!acp_probe_allowed(automatic, never, RefreshCause::Read));
        assert!(!acp_probe_allowed(
            Some(ModelProbe::OnRequest),
            due,
            RefreshCause::Read
        ));
        assert!(!acp_probe_allowed(None, due, RefreshCause::Request));
    }

    #[test]
    fn an_automatic_agent_waits_for_the_person_until_it_loaded_once() {
        assert_eq!(
            reported_probe(Some(ModelProbe::Automatic), false),
            Some(ModelProbe::OnRequest)
        );
        assert_eq!(
            reported_probe(Some(ModelProbe::Automatic), true),
            Some(ModelProbe::Automatic)
        );
        assert_eq!(
            reported_probe(Some(ModelProbe::OnRequest), true),
            Some(ModelProbe::OnRequest)
        );
    }

    #[test]
    fn attempts_are_spaced_per_row_and_survive_reregistration() {
        let mut spacing = AcpProbeSpacing::new(60_000.0).unwrap_or_else(|error| panic!("{error}"));
        assert!(spacing.admit("one", 1_000.0));
        assert!(!spacing.admit("one", 60_999.0));
        assert!(spacing.admit("one", 61_000.0));
        assert!(spacing.admit("two", 1_000.0));
        spacing.forget("one");
        assert!(spacing.admit("one", 1_001.0));
        assert!(AcpProbeSpacing::new(-1.0).is_err());
    }
}
