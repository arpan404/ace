// SPDX-License-Identifier: Apache-2.0

//! Pure inventory coordinator state machine (D2).
//!
//! No I/O, clocks, or timers live here: every side effect (watcher start/stop,
//! timer arm/cancel, SDK read dispatch, publish, warn log) is emitted as a
//! [`CoordinatorAction`] value for the thin shell to execute.

use crate::error::DeviceFailure;
use crate::inventory::model::{
    BACKOFF_INITIAL_MS, BACKOFF_MAX_MS, CoordinatorAction, CoordinatorConfig, Inventory,
    InventorySource, ReadScope, SourceHealth, TimerKind, diff_missed_sources, same_inventory,
};

#[derive(Debug, Clone)]
struct SourceState {
    enabled: bool,
    health: SourceHealth,
    backoff_ms: u64,
    ready_seq: u64,
    in_flight: bool,
    dirty: bool,
    pending_fallback: bool,
    triggered_since_liveness: bool,
    debounce_timer: Option<u64>,
    fallback_timer: Option<u64>,
    reconnect_timer: Option<u64>,
}

impl SourceState {
    fn new(enabled: bool) -> Self {
        Self {
            enabled,
            health: SourceHealth::Stopped,
            backoff_ms: BACKOFF_INITIAL_MS,
            ready_seq: 0,
            in_flight: false,
            dirty: false,
            pending_fallback: false,
            triggered_since_liveness: false,
            debounce_timer: None,
            fallback_timer: None,
            reconnect_timer: None,
        }
    }
}

#[derive(Debug, Clone)]
struct InFlightRead {
    read_id: u64,
    scope: ReadScope,
    liveness: bool,
    ready_snapshot: [u64; 3],
    liveness_baseline: Option<Inventory>,
}

/// Pure D2 inventory coordinator state machine.
#[derive(Debug)]
pub struct InventoryCoordinator {
    config: CoordinatorConfig,
    active: bool,
    last: Option<Inventory>,
    last_failure: String,
    sources: [SourceState; 3],
    next_timer_id: u64,
    next_read_id: u64,
    liveness_timer: Option<u64>,
    pending_reconcile: bool,
    pending_liveness: bool,
    reads: Vec<InFlightRead>,
}

impl InventoryCoordinator {
    pub fn new(config: CoordinatorConfig) -> Self {
        Self {
            config,
            active: false,
            last: None,
            last_failure: String::new(),
            sources: [
                SourceState::new(true),
                SourceState::new(true),
                SourceState::new(config.enable_ios),
            ],
            next_timer_id: 0,
            next_read_id: 0,
            liveness_timer: None,
            pending_reconcile: false,
            pending_liveness: false,
            reads: Vec::new(),
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn current(&self) -> Option<&Inventory> {
        self.last.as_ref()
    }

    pub fn source_health(&self, source: InventorySource) -> SourceHealth {
        self.sources[source.index()].health
    }

    pub fn has_in_flight_reads(&self) -> bool {
        !self.reads.is_empty()
    }

    /// Records a fresh inventory snapshot; returns `Publish` only when it differs from `last`.
    pub fn update(&mut self, inventory: Inventory) -> Option<CoordinatorAction> {
        if let Some(prev) = &self.last
            && same_inventory(prev, &inventory)
        {
            return None;
        }
        self.last = Some(inventory.clone());
        Some(CoordinatorAction::Publish(inventory))
    }

    /// Starts or stops inventory watching (`holdInventoryView` / `poll(active)`).
    /// Nothing runs while `active == false`.
    pub fn set_active(&mut self, active: bool) -> Vec<CoordinatorAction> {
        if active == self.active {
            return Vec::new();
        }
        self.active = active;
        let mut actions = Vec::new();
        if active {
            for source in InventorySource::ALL {
                let st = &mut self.sources[source.index()];
                if !st.enabled {
                    continue;
                }
                st.health = SourceHealth::Unhealthy;
                st.backoff_ms = BACKOFF_INITIAL_MS;
                st.dirty = false;
                st.pending_fallback = false;
                st.triggered_since_liveness = false;
                actions.push(CoordinatorAction::StartWatcher(source));
            }
            for source in InventorySource::ALL {
                if self.sources[source.index()].enabled {
                    self.arm_fallback(source, &mut actions);
                }
            }
            self.arm_liveness(&mut actions);
            // Holding the view runs one full reconcile read of all lists.
            self.request_full_read(false, &mut actions);
        } else {
            self.pending_reconcile = false;
            self.pending_liveness = false;
            if let Some(id) = self.liveness_timer.take() {
                actions.push(CoordinatorAction::CancelTimer { id });
            }
            for source in InventorySource::ALL {
                let st = &mut self.sources[source.index()];
                if !st.enabled {
                    continue;
                }
                st.health = SourceHealth::Stopped;
                st.dirty = false;
                st.pending_fallback = false;
                if let Some(id) = st.debounce_timer.take() {
                    actions.push(CoordinatorAction::CancelTimer { id });
                }
                if let Some(id) = st.fallback_timer.take() {
                    actions.push(CoordinatorAction::CancelTimer { id });
                }
                if let Some(id) = st.reconnect_timer.take() {
                    actions.push(CoordinatorAction::CancelTimer { id });
                }
                actions.push(CoordinatorAction::StopWatcher(source));
            }
        }
        actions
    }

    /// Reports that a source's watcher or adb track connection came up.
    /// `on_target = false` means a `notify` watch attached to a parent because the target dir
    /// does not exist yet: it stays `Unhealthy` (keeps 4 s fallback) until the target appears.
    pub fn on_watcher_ready(
        &mut self,
        source: InventorySource,
        on_target: bool,
    ) -> Vec<CoordinatorAction> {
        let mut actions = Vec::new();
        if !self.active || !self.sources[source.index()].enabled {
            return actions;
        }
        let st = &mut self.sources[source.index()];
        st.backoff_ms = BACKOFF_INITIAL_MS;
        if let Some(id) = st.reconnect_timer.take() {
            actions.push(CoordinatorAction::CancelTimer { id });
        }
        if on_target {
            st.ready_seq = st.ready_seq.saturating_add(1);
            st.health = SourceHealth::Reconciling;
            self.request_full_read(false, &mut actions);
        } else {
            st.health = SourceHealth::Unhealthy;
            self.arm_fallback(source, &mut actions);
        }
        actions
    }

    /// Reports that a source's watcher errored, received `need_rescan`, saw its folder
    /// deleted/replaced, or its adb track socket ended.
    pub fn on_watcher_lost(&mut self, source: InventorySource) -> Vec<CoordinatorAction> {
        let mut actions = Vec::new();
        if !self.active || !self.sources[source.index()].enabled {
            return actions;
        }
        self.mark_unhealthy_and_reconnect(source, &mut actions);
        actions
    }

    /// Reports a trigger event from a source (`host:track-devices-l` update or `notify` change).
    pub fn on_source_trigger(&mut self, source: InventorySource) -> Vec<CoordinatorAction> {
        let mut actions = Vec::new();
        if !self.active || !self.sources[source.index()].enabled {
            return actions;
        }
        let st = &mut self.sources[source.index()];
        st.triggered_since_liveness = true;
        if st.in_flight {
            st.dirty = true;
            return actions;
        }
        if st.debounce_timer.is_none() {
            self.arm_debounce(source, &mut actions);
        }
        actions
    }

    /// Fires a previously armed timer by id; unknown/cancelled ids are ignored.
    pub fn on_timer_fired(&mut self, timer_id: u64) -> Vec<CoordinatorAction> {
        let mut actions = Vec::new();
        if !self.active {
            return actions;
        }
        if self.liveness_timer == Some(timer_id) {
            self.liveness_timer = None;
            self.request_full_read(true, &mut actions);
            return actions;
        }
        for source in InventorySource::ALL {
            let idx = source.index();
            if self.sources[idx].debounce_timer == Some(timer_id) {
                self.sources[idx].debounce_timer = None;
                self.start_source_read(source, false, &mut actions);
                return actions;
            }
            if self.sources[idx].fallback_timer == Some(timer_id) {
                self.sources[idx].fallback_timer = None;
                if matches!(
                    self.sources[idx].health,
                    SourceHealth::Unhealthy | SourceHealth::Reconciling
                ) {
                    self.start_source_read(source, true, &mut actions);
                }
                return actions;
            }
            if self.sources[idx].reconnect_timer == Some(timer_id) {
                self.sources[idx].reconnect_timer = None;
                actions.push(CoordinatorAction::StartWatcher(source));
                return actions;
            }
        }
        actions
    }

    /// Completes an in-flight read with a fresh inventory snapshot.
    pub fn on_read_succeeded(
        &mut self,
        read_id: u64,
        inventory: Inventory,
    ) -> Vec<CoordinatorAction> {
        let mut actions = Vec::new();
        let Some(pos) = self.reads.iter().position(|r| r.read_id == read_id) else {
            if let Some(pub_action) = self.update(inventory) {
                actions.push(pub_action);
            }
            return actions;
        };
        let finished = self.reads.remove(pos);
        self.clear_in_flight(finished.scope);
        self.last_failure.clear();

        // Check liveness reconcile for silent sources before overwriting `self.last`.
        let mut silent_sources = Vec::new();
        if finished.liveness
            && self.active
            && let Some(baseline) = &finished.liveness_baseline
        {
            for source in diff_missed_sources(baseline, &inventory) {
                let st = &self.sources[source.index()];
                if st.enabled && st.health == SourceHealth::Healthy && !st.triggered_since_liveness
                {
                    silent_sources.push(source);
                }
            }
        }

        if let Some(pub_action) = self.update(inventory) {
            actions.push(pub_action);
        }

        if !self.active {
            return actions;
        }

        // Promote Reconciling -> Healthy if this full read started after the source became ready.
        if finished.scope == ReadScope::All {
            for source in InventorySource::ALL {
                let idx = source.index();
                if self.sources[idx].health == SourceHealth::Reconciling
                    && finished.ready_snapshot[idx] == self.sources[idx].ready_seq
                {
                    self.sources[idx].health = SourceHealth::Healthy;
                    if let Some(id) = self.sources[idx].fallback_timer.take() {
                        actions.push(CoordinatorAction::CancelTimer { id });
                    }
                }
            }
        }

        // Any source caught silent by the liveness reconcile becomes unhealthy and restarts.
        for source in silent_sources {
            self.mark_unhealthy_and_reconnect(source, &mut actions);
        }

        if finished.liveness {
            self.arm_liveness(&mut actions);
        }

        self.rearm_unhealthy_fallbacks(finished.scope, &mut actions);
        self.drain_pending(&mut actions);
        actions
    }

    /// Completes an in-flight read that failed; preserves last devices and logs once per message.
    pub fn on_read_failed(
        &mut self,
        read_id: u64,
        failure: DeviceFailure,
        raw_message: &str,
    ) -> Vec<CoordinatorAction> {
        let mut actions = Vec::new();
        let finished = self
            .reads
            .iter()
            .position(|r| r.read_id == read_id)
            .map(|pos| self.reads.remove(pos));
        if let Some(ref entry) = finished {
            self.clear_in_flight(entry.scope);
        }
        let msg = if raw_message.is_empty() {
            "Device inventory failed"
        } else {
            raw_message
        };
        if msg != self.last_failure {
            self.last_failure = msg.to_owned();
            actions.push(CoordinatorAction::LogWarn {
                message: "Device inventory read failed".into(),
                detail: msg.to_owned(),
            });
        }
        let preserved = Inventory {
            devices: self
                .last
                .as_ref()
                .map(|inv| inv.devices.clone())
                .unwrap_or_default(),
            issues: vec![failure],
        };
        if let Some(pub_action) = self.update(preserved) {
            actions.push(pub_action);
        }

        if !self.active {
            return actions;
        }
        // Clear pending reconcile on error so a broken SDK waits for the 4 s fallback instead of spinning.
        self.pending_reconcile = false;
        if let Some(entry) = finished {
            if entry.liveness {
                self.pending_liveness = false;
                self.arm_liveness(&mut actions);
            }
            self.rearm_unhealthy_fallbacks(entry.scope, &mut actions);
        }
        actions
    }

    fn next_timer(&mut self) -> u64 {
        self.next_timer_id = self.next_timer_id.saturating_add(1);
        self.next_timer_id
    }

    fn next_read(&mut self) -> u64 {
        self.next_read_id = self.next_read_id.saturating_add(1);
        self.next_read_id
    }

    fn any_in_flight(&self) -> bool {
        self.sources.iter().any(|s| s.in_flight)
    }

    fn arm_debounce(&mut self, source: InventorySource, actions: &mut Vec<CoordinatorAction>) {
        let id = self.next_timer();
        self.sources[source.index()].debounce_timer = Some(id);
        actions.push(CoordinatorAction::ArmTimer {
            id,
            kind: TimerKind::Debounce(source),
            delay_ms: self.config.debounce_ms,
        });
    }

    fn arm_fallback(&mut self, source: InventorySource, actions: &mut Vec<CoordinatorAction>) {
        let idx = source.index();
        if !self.sources[idx].enabled
            || self.sources[idx].fallback_timer.is_some()
            || self.sources[idx].health == SourceHealth::Healthy
            || self.sources[idx].health == SourceHealth::Stopped
        {
            return;
        }
        let id = self.next_timer();
        self.sources[idx].fallback_timer = Some(id);
        actions.push(CoordinatorAction::ArmTimer {
            id,
            kind: TimerKind::Fallback(source),
            delay_ms: self.config.fallback_interval_ms,
        });
    }

    fn arm_liveness(&mut self, actions: &mut Vec<CoordinatorAction>) {
        if !self.active || self.liveness_timer.is_some() {
            return;
        }
        let id = self.next_timer();
        self.liveness_timer = Some(id);
        actions.push(CoordinatorAction::ArmTimer {
            id,
            kind: TimerKind::Liveness,
            delay_ms: self.config.liveness_interval_ms,
        });
    }

    fn mark_unhealthy_and_reconnect(
        &mut self,
        source: InventorySource,
        actions: &mut Vec<CoordinatorAction>,
    ) {
        let idx = source.index();
        self.sources[idx].health = SourceHealth::Unhealthy;
        actions.push(CoordinatorAction::StopWatcher(source));
        self.arm_fallback(source, actions);
        // Never run concurrent reconnects for the same source.
        if self.sources[idx].reconnect_timer.is_none() {
            let delay_ms = self.sources[idx].backoff_ms;
            self.sources[idx].backoff_ms = (delay_ms.saturating_mul(2)).min(BACKOFF_MAX_MS);
            let id = self.next_timer();
            self.sources[idx].reconnect_timer = Some(id);
            actions.push(CoordinatorAction::ArmTimer {
                id,
                kind: TimerKind::Reconnect(source),
                delay_ms,
            });
        }
    }

    fn request_full_read(&mut self, liveness: bool, actions: &mut Vec<CoordinatorAction>) {
        if self.any_in_flight() {
            if liveness {
                self.pending_liveness = true;
            } else {
                self.pending_reconcile = true;
            }
            return;
        }
        self.dispatch_full_read(liveness, actions);
    }

    fn dispatch_full_read(&mut self, liveness: bool, actions: &mut Vec<CoordinatorAction>) {
        self.pending_reconcile = false;
        if liveness {
            self.pending_liveness = false;
        }
        let read_id = self.next_read();
        let ready_snapshot = [
            self.sources[0].ready_seq,
            self.sources[1].ready_seq,
            self.sources[2].ready_seq,
        ];
        for source in InventorySource::ALL {
            let st = &mut self.sources[source.index()];
            if st.enabled {
                st.in_flight = true;
                st.dirty = false;
                st.pending_fallback = false;
                if liveness {
                    st.triggered_since_liveness = false;
                }
                if let Some(id) = st.debounce_timer.take() {
                    actions.push(CoordinatorAction::CancelTimer { id });
                }
            }
        }
        self.reads.push(InFlightRead {
            read_id,
            scope: ReadScope::All,
            liveness,
            ready_snapshot,
            liveness_baseline: if liveness { self.last.clone() } else { None },
        });
        actions.push(CoordinatorAction::StartRead {
            read_id,
            scope: ReadScope::All,
            liveness,
        });
    }

    fn start_source_read(
        &mut self,
        source: InventorySource,
        from_fallback: bool,
        actions: &mut Vec<CoordinatorAction>,
    ) {
        let idx = source.index();
        if !self.sources[idx].enabled {
            return;
        }
        if self.sources[idx].in_flight {
            if from_fallback {
                self.sources[idx].pending_fallback = true;
            } else {
                self.sources[idx].dirty = true;
            }
            return;
        }
        self.sources[idx].in_flight = true;
        self.sources[idx].dirty = false;
        self.sources[idx].pending_fallback = false;
        let read_id = self.next_read();
        let ready_snapshot = [
            self.sources[0].ready_seq,
            self.sources[1].ready_seq,
            self.sources[2].ready_seq,
        ];
        self.reads.push(InFlightRead {
            read_id,
            scope: ReadScope::Source(source),
            liveness: false,
            ready_snapshot,
            liveness_baseline: None,
        });
        actions.push(CoordinatorAction::StartRead {
            read_id,
            scope: ReadScope::Source(source),
            liveness: false,
        });
    }

    fn clear_in_flight(&mut self, scope: ReadScope) {
        match scope {
            ReadScope::All => {
                for st in &mut self.sources {
                    st.in_flight = false;
                }
            }
            ReadScope::Source(source) => {
                self.sources[source.index()].in_flight = false;
            }
        }
    }

    fn rearm_unhealthy_fallbacks(
        &mut self,
        scope: ReadScope,
        actions: &mut Vec<CoordinatorAction>,
    ) {
        match scope {
            ReadScope::All => {
                for source in InventorySource::ALL {
                    self.arm_fallback(source, actions);
                }
            }
            ReadScope::Source(source) => {
                self.arm_fallback(source, actions);
            }
        }
    }

    fn drain_pending(&mut self, actions: &mut Vec<CoordinatorAction>) {
        if self.pending_liveness && !self.any_in_flight() {
            self.dispatch_full_read(true, actions);
            return;
        }
        if self.pending_reconcile && !self.any_in_flight() {
            self.dispatch_full_read(false, actions);
            return;
        }
        for source in InventorySource::ALL {
            let idx = source.index();
            if self.sources[idx].pending_fallback && !self.sources[idx].in_flight {
                self.sources[idx].pending_fallback = false;
                self.start_source_read(source, true, actions);
            } else if self.sources[idx].dirty
                && !self.sources[idx].in_flight
                && self.sources[idx].debounce_timer.is_none()
            {
                self.sources[idx].dirty = false;
                self.arm_debounce(source, actions);
            }
        }
    }
}
