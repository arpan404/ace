// SPDX-License-Identifier: Apache-2.0
//! `posture.ts`, `simulator-posture.ts` and `android-posture.ts`: how a foldable device's hinge
//! sits, from `devicectl`'s display report or the emulator console, and what ace learns about a
//! device once (a phone has no posture, and is not asked again). The machines are resumable: the
//! shell runs the command each step names and hands the answer back.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::platform::{Error, Refusal};

/// How a foldable device's hinge sits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Posture {
    Closed,
    PartiallyOpen,
    Open,
}

/// The hinge angle each posture folds to, in degrees: 0 is shut, 180 flat. Half open sits well
/// inside the system's partly-open band, where a book rests.
pub fn posture_angle(posture: Posture) -> u16 {
    match posture {
        Posture::Closed => 0,
        Posture::PartiallyOpen => 120,
        Posture::Open => 180,
    }
}

/// One screen in a `devicectl` display report, as posture reads it.
#[derive(Debug, Clone, Deserialize)]
struct Display {
    #[serde(default)]
    primary: Option<bool>,
    #[serde(default)]
    active: Option<bool>,
    #[serde(rename = "backlightState", default)]
    backlight_state: Option<String>,
}

/// The displays a report lists, or `None` when the report can't be read (the schema caps it at
/// sixteen, so a longer list is unreadable rather than partial).
fn displays(report: &Value) -> Option<Vec<Display>> {
    let list = report.get("result")?.get("displays")?.as_array()?;
    if list.len() > 16 {
        return None;
    }
    Some(
        list.iter()
            .filter_map(|raw| serde_json::from_value(raw.clone()).ok())
            .collect(),
    )
}

/// How many screens a `devicectl` display report lists, or `None` when it can't be read.
pub fn screen_count(report: &Value) -> Option<usize> {
    displays(report).map(|displays| displays.len())
}

/// A device's posture from `devicectl device info displays --json-output`, or `None` when it has
/// fewer than two built-in screens (it doesn't fold) or the report can't be read.
///
/// The lit panel decides: the cover (the primary display) lit means closed, the inner one lit
/// means open. A panel's `active` flag lags a fold, so it only breaks the tie when both or
/// neither panel is lit (the screen asleep). The inner panel can't tell open from half open, so
/// the last posture ace asked for decides between them.
pub fn read_posture(report: &Value, requested: Option<Posture>) -> Option<Posture> {
    let displays = displays(report)?;
    if displays.len() < 2 {
        return None;
    }
    let cover = displays
        .iter()
        .position(|display| display.primary == Some(true))
        .unwrap_or(0);
    let lit: Vec<usize> = displays
        .iter()
        .enumerate()
        .filter(|(_, display)| {
            display
                .backlight_state
                .as_deref()
                .is_some_and(|state| state != "off")
        })
        .map(|(index, _)| index)
        .collect();
    let shown = if lit.len() == 1 {
        Some(lit[0])
    } else {
        displays
            .iter()
            .position(|display| display.active == Some(true))
    };
    if shown == Some(cover) {
        return Some(Posture::Closed);
    }
    if requested == Some(Posture::PartiallyOpen) {
        return Some(Posture::PartiallyOpen);
    }
    if shown.is_none() && requested == Some(Posture::Closed) {
        return Some(Posture::Closed);
    }
    Some(Posture::Open)
}

/// Reads in a row that found one screen before a simulator is taken to have one screen for good.
const SETTLED_READS: u32 = 3;

/// What the shell must run next for a Simulator's posture, or the answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SimulatorStep {
    /// `xcrun devicectl device info displays --device <udid> --quiet --json-output -`.
    Displays { udid: String },
    /// `<helper> --sim-posture <udid> --check`.
    Check { udid: String },
    /// The helper can't fold this simulator.
    Done { posture: Option<Posture> },
    /// `<helper> --sim-posture <udid> --from <angle> --to <angle>`.
    Fold { udid: String, from: u16, to: u16 },
}

/// Whether a device folds is learned once per simulator, and how many reads in a row found one
/// screen decides when it stops being asked.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SimulatorPostures {
    foldable: BTreeMap<String, bool>,
    requested: BTreeMap<String, Posture>,
    one_screen: BTreeMap<String, u32>,
    #[serde(skip)]
    pending: Option<Posture>,
}

impl SimulatorPostures {
    pub fn new() -> Self {
        Self::default()
    }

    /// The simulator's posture, or the command its read needs next.
    pub fn read(&mut self, udid: &str) -> SimulatorStep {
        let seen = self.one_screen.get(udid).copied().unwrap_or(0);
        if seen >= SETTLED_READS {
            return SimulatorStep::Done { posture: None };
        }
        self.pending = None;
        SimulatorStep::Displays {
            udid: udid.to_string(),
        }
    }

    /// The displays `devicectl` printed, or `None` when the command failed or printed no JSON.
    pub fn displays(&mut self, udid: &str, report: Option<&Value>) -> SimulatorStep {
        let seen = self.one_screen.get(udid).copied().unwrap_or(0);
        let Some(report) = report else {
            return SimulatorStep::Done { posture: None };
        };
        if let Some(screens) = screen_count(report)
            && screens < 2
        {
            self.one_screen.insert(udid.to_string(), seen + 1);
            return SimulatorStep::Done { posture: None };
        }
        self.one_screen.remove(udid);
        let posture = read_posture(report, self.requested.get(udid).copied());
        let Some(posture) = posture else {
            return SimulatorStep::Done { posture: None };
        };
        if self.foldable.get(udid) == Some(&true) {
            return SimulatorStep::Done {
                posture: Some(posture),
            };
        }
        self.pending = Some(posture);
        SimulatorStep::Check {
            udid: udid.to_string(),
        }
    }

    /// Whether the helper can fold this simulator; a failed check is asked again next time.
    pub fn check(&mut self, udid: &str, available: bool) -> SimulatorStep {
        self.foldable.insert(udid.to_string(), available);
        if !available {
            self.pending = None;
            return SimulatorStep::Done { posture: None };
        }
        SimulatorStep::Done {
            posture: self.pending.take(),
        }
    }

    /// Folds the simulator to `posture` from the one its last read found.
    pub fn set(&mut self, udid: &str, posture: Posture, from: Posture) -> SimulatorStep {
        SimulatorStep::Fold {
            udid: udid.to_string(),
            from: posture_angle(from),
            to: posture_angle(posture),
        }
    }

    /// The helper folded: the posture asked for is what it reports until the next read.
    pub fn folded(&mut self, udid: &str, posture: Posture, ok: bool) -> Result<Posture, Error> {
        if !ok {
            self.foldable.remove(udid);
            return Err(Refusal::word("simulatorFoldFailed").into());
        }
        self.requested.insert(udid.to_string(), posture);
        Ok(posture)
    }
}

/// Whether `emu sensor status` lists the first hinge sensor as enabled: the device folds.
pub fn has_hinge(status: &str) -> bool {
    status.lines().any(|line| {
        let Some(rest) = line.trim_start().strip_prefix("hinge-angle0:") else {
            return false;
        };
        let rest = rest.trim_start();
        rest == "enabled" || rest.starts_with("enabled ") || rest.starts_with("enabled.")
    })
}

/// The posture a hinge angle stands for, from `emu sensor get hinge-angle0`, or `None` when the
/// reply holds no angle. Android's foldable emulators call under 30° closed and from 150° open;
/// the band between is half open.
pub fn posture_from_hinge(reply: &str) -> Option<Posture> {
    let start = reply.find("hinge-angle0")?;
    let rest = &reply[start + "hinge-angle0".len()..];
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let end = rest
        .find(|character: char| {
            !(character.is_ascii_digit() || character == '-' || character == '.')
        })
        .unwrap_or(rest.len());
    let angle: f64 = rest[..end].parse().ok()?;
    if !angle.is_finite() {
        return None;
    }
    if angle < 30.0 {
        Some(Posture::Closed)
    } else if angle < 150.0 {
        Some(Posture::PartiallyOpen)
    } else {
        Some(Posture::Open)
    }
}

/// What the shell must run next for an Android emulator's posture, or the answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EmulatorStep {
    /// `adb -s <serial> emu sensor status`.
    Status,
    /// `adb -s <serial> emu sensor get hinge-angle0`.
    Hinge,
    /// `adb -s <serial> emu posture <1|2|3>`.
    Fold {
        id: String,
    },
    Done {
        posture: Option<Posture>,
    },
}

/// Folds Android emulators that have a hinge through the emulator console. A physical phone or an
/// emulator without a hinge has no posture, never an error a person sees.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct EmulatorPostures {
    hinged: Vec<String>,
    unhinged: BTreeMap<String, u32>,
    #[serde(skip)]
    setting: Option<Posture>,
}

/// The emulator console's posture numbers: 1 closed, 2 half-opened, 3 opened.
fn posture_id(posture: Posture) -> &'static str {
    match posture {
        Posture::Closed => "1",
        Posture::PartiallyOpen => "2",
        Posture::Open => "3",
    }
}

impl EmulatorPostures {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn read(&mut self, id: &str) -> EmulatorStep {
        if self.hinged.iter().any(|hinged| hinged == id) {
            return EmulatorStep::Hinge;
        }
        let misses = self.unhinged.get(id).copied().unwrap_or(0);
        if misses >= SETTLED_READS {
            return EmulatorStep::Done { posture: None };
        }
        EmulatorStep::Status
    }

    /// The console's answer to `emu sensor status`; a phone with no console counts as a miss.
    pub fn status(&mut self, id: &str, succeeded: bool, stdout: &str) -> EmulatorStep {
        if succeeded && has_hinge(stdout) {
            if !self.hinged.iter().any(|hinged| hinged == id) {
                self.hinged.push(id.to_string());
            }
            self.unhinged.remove(id);
            return EmulatorStep::Hinge;
        }
        let misses = self.unhinged.get(id).copied().unwrap_or(0);
        self.unhinged.insert(id.to_string(), misses + 1);
        EmulatorStep::Done { posture: None }
    }

    pub fn hinge(&mut self, succeeded: bool, stdout: &str) -> EmulatorStep {
        if !succeeded {
            return EmulatorStep::Done { posture: None };
        }
        EmulatorStep::Done {
            posture: posture_from_hinge(stdout),
        }
    }

    pub fn set(&mut self, id: &str, posture: Posture) -> Result<EmulatorStep, Error> {
        if !self.hinged.iter().any(|hinged| hinged == id) {
            if self.unhinged.contains_key(id) {
                return Err(Refusal::word("androidNoFold").into());
            }
            self.setting = Some(posture);
            return Ok(EmulatorStep::Status);
        }
        self.setting = Some(posture);
        Ok(EmulatorStep::Fold { id: id.to_string() })
    }

    /// The posture number to send for the fold the last `set` asked for.
    pub fn posture_id(&self) -> Option<&'static str> {
        self.setting.map(posture_id)
    }

    pub fn folded(&mut self, succeeded: bool, stdout: &str) -> Result<Posture, Error> {
        let posture = self
            .setting
            .ok_or_else(|| Error::Invalid("an emulator fold has no posture to report".into()))?;
        if !succeeded || !stdout.starts_with("OK") {
            return Err(Refusal::word("androidFoldFailed").into());
        }
        Ok(posture)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn duo(cover_lit: bool, inner_lit: bool) -> Value {
        json!({
            "result": {
                "displays": [
                    {"primary": true, "active": !cover_lit, "backlightState": if cover_lit {"activeOn"} else {"off"}},
                    {"primary": false, "active": inner_lit, "backlightState": if inner_lit {"activeOn"} else {"off"}},
                ]
            }
        })
    }

    #[test]
    fn a_lit_cover_screen_reads_as_closed_even_while_the_inner_one_is_still_marked_active() {
        let report = json!({"result": {"displays": [
            {"primary": true, "active": false, "backlightState": "activeOn"},
            {"primary": false, "active": true, "backlightState": "off"},
        ]}});
        assert_eq!(read_posture(&report, None), Some(Posture::Closed));
    }

    #[test]
    fn a_lit_inner_screen_reads_as_open() {
        assert_eq!(read_posture(&duo(false, true), None), Some(Posture::Open));
    }

    #[test]
    fn the_inner_screen_stays_half_open_when_half_open_was_the_last_posture_asked_for() {
        let report = duo(false, true);
        assert_eq!(
            read_posture(&report, Some(Posture::PartiallyOpen)),
            Some(Posture::PartiallyOpen)
        );
        assert_eq!(
            read_posture(&report, Some(Posture::Closed)),
            Some(Posture::Open)
        );
    }

    #[test]
    fn with_both_screens_asleep_the_active_screen_decides() {
        let cover = json!({"result": {"displays": [
            {"primary": true, "active": true, "backlightState": "off"},
            {"primary": false, "active": false, "backlightState": "off"},
        ]}});
        assert_eq!(read_posture(&cover, None), Some(Posture::Closed));
        let inner = json!({"result": {"displays": [
            {"primary": true, "active": false, "backlightState": "off"},
            {"primary": false, "active": true, "backlightState": "off"},
        ]}});
        assert_eq!(read_posture(&inner, None), Some(Posture::Open));
    }

    #[test]
    fn a_device_with_one_screen_or_a_report_that_cannot_be_read_has_no_posture() {
        let phone = json!({"result": {"displays": [
            {"name": "LCD", "primary": true, "active": true, "backlightState": "activeOn"}
        ]}});
        assert_eq!(read_posture(&phone, None), None);
        assert_eq!(screen_count(&phone), Some(1));
        assert_eq!(
            read_posture(&json!({"error": "device not found"}), None),
            None
        );
        assert_eq!(screen_count(&json!("not json")), None);
    }

    #[test]
    fn a_hinge_entry_is_only_the_first_sensor_and_only_when_enabled() {
        assert!(has_hinge(
            "acceleration: enabled.\nhinge-angle0: enabled.\nOK\n"
        ));
        assert!(!has_hinge("hinge-angle0: disabled.\nOK\n"));
        assert!(!has_hinge("hinge-angle1: enabled.\nOK\n"));
    }

    #[test]
    fn an_angle_under_thirty_is_closed_under_one_fifty_half_open_and_the_rest_open() {
        assert_eq!(
            posture_from_hinge("hinge-angle0 = 0\nOK\n"),
            Some(Posture::Closed)
        );
        assert_eq!(
            posture_from_hinge("hinge-angle0 = 90.5\nOK\n"),
            Some(Posture::PartiallyOpen)
        );
        assert_eq!(
            posture_from_hinge("hinge-angle0 = 180\nOK\n"),
            Some(Posture::Open)
        );
        assert_eq!(
            posture_from_hinge("hinge-angle0 = 149.9\nOK\n"),
            Some(Posture::PartiallyOpen)
        );
        assert_eq!(posture_from_hinge("OK\n"), None);
    }

    /// An emulator console that answers the way the Android emulator does.
    struct Console {
        hinge: bool,
        console: bool,
        angle: f64,
        asked: Vec<String>,
    }

    impl Console {
        fn new(hinge: bool, console: bool) -> Self {
            Self {
                hinge,
                console,
                angle: 180.0,
                asked: Vec::new(),
            }
        }

        fn status(&mut self) -> (bool, String) {
            self.asked.push("emu sensor status".into());
            if !self.console {
                return (false, String::new());
            }
            let state = if self.hinge { "enabled" } else { "disabled" };
            (
                true,
                format!("acceleration: enabled.\nhinge-angle0: {state}.\nOK\n"),
            )
        }

        fn hinge_reply(&mut self) -> (bool, String) {
            self.asked.push("emu sensor get hinge-angle0".into());
            if !self.console {
                return (false, String::new());
            }
            (true, format!("hinge-angle0 = {}\nOK\n", self.angle))
        }

        fn fold(&mut self, id: &str) -> (bool, String) {
            self.asked.push("emu posture".into());
            self.angle = match id {
                "1" => 0.0,
                "2" => 90.0,
                _ => 180.0,
            };
            (true, "OK\n".into())
        }
    }

    fn read(postures: &mut EmulatorPostures, console: &mut Console, id: &str) -> Option<Posture> {
        let mut step = postures.read(id);
        loop {
            step = match step {
                EmulatorStep::Status => {
                    let (ok, out) = console.status();
                    postures.status(id, ok, &out)
                }
                EmulatorStep::Hinge => {
                    let (ok, out) = console.hinge_reply();
                    postures.hinge(ok, &out)
                }
                EmulatorStep::Fold { .. } => panic!("a read never folds"),
                EmulatorStep::Done { posture } => return posture,
            };
        }
    }

    fn set(
        postures: &mut EmulatorPostures,
        console: &mut Console,
        id: &str,
        posture: Posture,
    ) -> Result<Posture, Error> {
        let mut step = postures.set(id, posture)?;
        loop {
            step = match step {
                EmulatorStep::Status => {
                    let (ok, out) = console.status();
                    postures.status(id, ok, &out)
                }
                EmulatorStep::Hinge => {
                    let (ok, out) = console.hinge_reply();
                    postures.hinge(ok, &out)
                }
                EmulatorStep::Fold { .. } => {
                    let number = postures.posture_id().expect("a posture");
                    let (ok, out) = console.fold(number);
                    return postures.folded(ok, &out);
                }
                EmulatorStep::Done { .. } => postures.set(id, posture)?,
            };
        }
    }

    #[test]
    fn a_pixel_fold_emulator_reads_open_folds_shut_then_half_open() {
        let id = "android:Pixel_9_Pro_Fold";
        let mut postures = EmulatorPostures::new();
        let mut console = Console::new(true, true);
        assert_eq!(read(&mut postures, &mut console, id), Some(Posture::Open));
        assert_eq!(
            set(&mut postures, &mut console, id, Posture::Closed).ok(),
            Some(Posture::Closed)
        );
        assert_eq!(read(&mut postures, &mut console, id), Some(Posture::Closed));
        set(&mut postures, &mut console, id, Posture::PartiallyOpen).expect("folds");
        assert_eq!(
            read(&mut postures, &mut console, id),
            Some(Posture::PartiallyOpen)
        );
    }

    #[test]
    fn an_emulator_without_a_hinge_has_no_posture_and_refuses_to_fold() {
        let id = "android:Pixel_9";
        let mut postures = EmulatorPostures::new();
        let mut console = Console::new(false, true);
        assert_eq!(read(&mut postures, &mut console, id), None);
        let error = set(&mut postures, &mut console, id, Posture::Closed).expect_err("refused");
        assert_eq!(error.to_string(), "not_supported: This device doesn't fold");
        assert!(!console.asked.iter().any(|asked| asked == "emu posture"));
    }

    #[test]
    fn a_physical_phone_which_has_no_console_has_no_posture_and_soon_stops_being_asked() {
        let id = "android:Pixel_9";
        let mut postures = EmulatorPostures::new();
        let mut console = Console::new(true, false);
        for _ in 0..10 {
            assert_eq!(read(&mut postures, &mut console, id), None);
        }
        assert!(
            console.asked.len() < 10,
            "asked {} times",
            console.asked.len()
        );
    }

    /// A simulated iPhone Duo: `devicectl` reports its screens and the helper moves its hinge.
    struct Duo {
        screens: usize,
        helper: bool,
        angle: f64,
        moves: Vec<(u16, u16)>,
        reads: usize,
    }

    impl Duo {
        fn new(screens: usize, helper: bool) -> Self {
            Self {
                screens,
                helper,
                angle: 180.0,
                moves: Vec::new(),
                reads: 0,
            }
        }

        fn report(&mut self) -> Option<Value> {
            self.reads += 1;
            let displays = [
                json!({"primary": true, "active": self.angle >= 90.0, "backlightState": if self.angle < 90.0 {"activeOn"} else {"off"}}),
                json!({"primary": false, "active": self.angle < 90.0, "backlightState": if self.angle >= 90.0 {"activeOn"} else {"off"}}),
            ];
            Some(json!({"result": {"displays": &displays[..self.screens]}}))
        }
    }

    fn read_sim(postures: &mut SimulatorPostures, duo: &mut Duo, udid: &str) -> Option<Posture> {
        let mut step = postures.read(udid);
        loop {
            step = match step {
                SimulatorStep::Displays { .. } => {
                    let report = duo.report();
                    postures.displays(udid, report.as_ref())
                }
                SimulatorStep::Check { .. } => postures.check(udid, duo.helper),
                SimulatorStep::Fold { .. } => panic!("a read never folds"),
                SimulatorStep::Done { posture } => return posture,
            };
        }
    }

    fn set_sim(
        postures: &mut SimulatorPostures,
        duo: &mut Duo,
        udid: &str,
        posture: Posture,
    ) -> Result<Posture, Error> {
        let current = read_sim(postures, duo, udid)
            .ok_or_else(|| Error::from(Refusal::word("simulatorNoFold")))?;
        match postures.set(udid, posture, current) {
            SimulatorStep::Fold { from, to, .. } => {
                duo.moves.push((from, to));
                duo.angle = f64::from(to);
                postures.folded(udid, posture, true)
            }
            other => Err(Error::Invalid(format!("unexpected step {other:?}"))),
        }
    }

    #[test]
    fn an_open_iphone_duo_folds_shut_from_flat_and_then_reads_as_closed() {
        let udid = "D8ABBF92";
        let mut postures = SimulatorPostures::new();
        let mut duo = Duo::new(2, true);
        assert_eq!(read_sim(&mut postures, &mut duo, udid), Some(Posture::Open));
        assert_eq!(
            set_sim(&mut postures, &mut duo, udid, Posture::Closed).ok(),
            Some(Posture::Closed)
        );
        assert_eq!(duo.moves, vec![(180, 0)]);
        assert_eq!(
            read_sim(&mut postures, &mut duo, udid),
            Some(Posture::Closed)
        );
    }

    #[test]
    fn half_open_sweeps_from_wherever_the_hinge_is_and_is_remembered_on_the_inner_screen() {
        let udid = "D8ABBF92";
        let mut postures = SimulatorPostures::new();
        let mut duo = Duo::new(2, true);
        set_sim(&mut postures, &mut duo, udid, Posture::Closed).expect("folds");
        set_sim(&mut postures, &mut duo, udid, Posture::PartiallyOpen).expect("folds");
        assert_eq!(duo.moves.last(), Some(&(0, 120)));
        assert_eq!(
            read_sim(&mut postures, &mut duo, udid),
            Some(Posture::PartiallyOpen)
        );
        set_sim(&mut postures, &mut duo, udid, Posture::Open).expect("folds");
        assert_eq!(duo.moves.last(), Some(&(120, 180)));
        assert_eq!(read_sim(&mut postures, &mut duo, udid), Some(Posture::Open));
    }

    #[test]
    fn a_phone_with_one_screen_has_no_posture_and_refuses_to_fold() {
        let udid = "D8ABBF92";
        let mut postures = SimulatorPostures::new();
        let mut duo = Duo::new(1, true);
        assert_eq!(read_sim(&mut postures, &mut duo, udid), None);
        let error = set_sim(&mut postures, &mut duo, udid, Posture::Closed).expect_err("refused");
        assert_eq!(error.to_string(), "not_supported: This device doesn't fold");
        assert!(duo.moves.is_empty());
    }

    #[test]
    fn an_xcode_without_the_hinge_service_offers_no_posture_at_all() {
        let udid = "D8ABBF92";
        let mut postures = SimulatorPostures::new();
        let mut duo = Duo::new(2, false);
        assert_eq!(read_sim(&mut postures, &mut duo, udid), None);
    }

    #[test]
    fn a_duo_that_lists_one_screen_while_booting_gains_its_posture_once_both_appear() {
        let udid = "D8ABBF92";
        let mut postures = SimulatorPostures::new();
        let mut duo = Duo::new(1, true);
        assert_eq!(read_sim(&mut postures, &mut duo, udid), None);
        assert_eq!(read_sim(&mut postures, &mut duo, udid), None);
        duo.screens = 2;
        assert_eq!(read_sim(&mut postures, &mut duo, udid), Some(Posture::Open));
    }

    #[test]
    fn a_phone_that_keeps_listing_one_screen_stops_running_devicectl() {
        let udid = "D8ABBF92";
        let mut postures = SimulatorPostures::new();
        let mut duo = Duo::new(1, true);
        for _ in 0..10 {
            assert_eq!(read_sim(&mut postures, &mut duo, udid), None);
        }
        assert!(duo.reads < 10, "read {} times", duo.reads);
    }

    #[test]
    fn the_angles_a_fold_uses_are_the_ones_posture_names() {
        assert_eq!(posture_angle(Posture::Closed), 0);
        assert_eq!(posture_angle(Posture::PartiallyOpen), 120);
        assert_eq!(posture_angle(Posture::Open), 180);
        assert_eq!(posture_id(Posture::Closed), "1");
        assert_eq!(posture_id(Posture::PartiallyOpen), "2");
        assert_eq!(posture_id(Posture::Open), "3");
    }
}
