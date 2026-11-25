// SPDX-License-Identifier: Apache-2.0
//! Pure parser for `adb devices -l` lines and Android transport identity
//! (ports `packages/devices/src/adb-transports.ts`).

use crate::error::{DeviceError, DeviceErrorCode};
use ace_json::{JsString, ObjectWriter, Value};

/// Maximum connected Android transports accepted in one read (`adb-transports.ts:29`).
pub const MAX_TRANSPORTS: usize = 128;

/// Maximum UTF-16 code units kept for a transport's `model` (`adb-transports.ts:51`).
const MAX_MODEL_UTF16: usize = 128;

/// Maximum UTF-16 code units allowed in an adb serial or physical id part.
const MAX_SERIAL_UTF16: usize = 200;

/// How adb reaches an Android device (`adb-transports.ts:7`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AdbTransportKind {
    Emulator,
    Usb,
    Network,
}

impl AdbTransportKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Emulator => "emulator",
            Self::Usb => "usb",
            Self::Network => "network",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "emulator" => Some(Self::Emulator),
            "usb" => Some(Self::Usb),
            "network" => Some(Self::Network),
            _ => None,
        }
    }
}

/// Why a transport cannot be used yet (`adb-transports.ts:14`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AdbBlock {
    Unauthorized,
    NoPermissions,
}

impl AdbBlock {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::NoPermissions => "no_permissions",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "unauthorized" => Some(Self::Unauthorized),
            "no_permissions" => Some(Self::NoPermissions),
            _ => None,
        }
    }
}

/// Device availability state on the wire (`packages/protocol/src/devices.ts:24`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DeviceState {
    Booted,
    Shutdown,
    Offline,
    Unauthorized,
}

impl DeviceState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Booted => "booted",
            Self::Shutdown => "shutdown",
            Self::Offline => "offline",
            Self::Unauthorized => "unauthorized",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "booted" => Some(Self::Booted),
            "shutdown" => Some(Self::Shutdown),
            "offline" => Some(Self::Offline),
            "unauthorized" => Some(Self::Unauthorized),
            _ => None,
        }
    }
}

/// One parsed line of `adb devices -l` (`adb-transports.ts:17-27`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdbTransport {
    pub serial: JsString,
    pub kind: AdbTransportKind,
    pub state: DeviceState,
    pub block: Option<AdbBlock>,
    pub model: Option<JsString>,
    pub usb: Option<JsString>,
}

impl AdbTransport {
    /// Serializes with `ace-json` in `AdbTransport` field order.
    pub fn write_json(&self, out: &mut String) {
        let mut obj = ObjectWriter::new(out);
        obj.value("serial", &Value::String(self.serial.clone()));
        obj.str("kind", self.kind.as_str());
        obj.str("state", self.state.as_str());
        if let Some(block) = self.block {
            obj.str("block", block.as_str());
        }
        if let Some(model) = &self.model {
            obj.value("model", &Value::String(model.clone()));
        }
        if let Some(usb) = &self.usb {
            obj.value("usb", &Value::String(usb.clone()));
        }
        obj.finish();
    }

    pub fn from_value(value: &Value) -> Result<Self, DeviceError> {
        let obj = value
            .as_object()
            .ok_or_else(|| DeviceError::InvalidInput("AdbTransport must be an object".into()))?;
        let serial = obj
            .get("serial")
            .and_then(Value::as_js_str)
            .cloned()
            .ok_or_else(|| DeviceError::InvalidInput("AdbTransport.serial missing".into()))?;
        let kind_str = obj
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| DeviceError::InvalidInput("AdbTransport.kind missing".into()))?;
        let kind = AdbTransportKind::parse(kind_str).ok_or_else(|| {
            DeviceError::InvalidInput(format!("unknown AdbTransport.kind: {kind_str}"))
        })?;
        let state_str = obj
            .get("state")
            .and_then(Value::as_str)
            .ok_or_else(|| DeviceError::InvalidInput("AdbTransport.state missing".into()))?;
        let state = DeviceState::parse(state_str).ok_or_else(|| {
            DeviceError::InvalidInput(format!("unknown AdbTransport.state: {state_str}"))
        })?;
        let block = match obj.get("block") {
            None | Some(Value::Null) => None,
            Some(v) => {
                let s = v.as_str().ok_or_else(|| {
                    DeviceError::InvalidInput("AdbTransport.block must be string".into())
                })?;
                Some(AdbBlock::parse(s).ok_or_else(|| {
                    DeviceError::InvalidInput(format!("unknown AdbTransport.block: {s}"))
                })?)
            }
        };
        let model = match obj.get("model") {
            None | Some(Value::Null) => None,
            Some(v) => Some(v.as_js_str().cloned().ok_or_else(|| {
                DeviceError::InvalidInput("AdbTransport.model must be string".into())
            })?),
        };
        let usb = match obj.get("usb") {
            None | Some(Value::Null) => None,
            Some(v) => Some(v.as_js_str().cloned().ok_or_else(|| {
                DeviceError::InvalidInput("AdbTransport.usb must be string".into())
            })?),
        };
        Ok(Self {
            serial,
            kind,
            state,
            block,
            model,
            usb,
        })
    }
}

/// JavaScript `\s` whitespace test on a single UTF-16 code unit (ECMA-262 WhiteSpace + LineTerminator).
pub(crate) fn is_js_whitespace_unit(unit: u16) -> bool {
    matches!(
        unit,
        0x0009..=0x000d
            | 0x0020
            | 0x00a0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

fn trim_units(mut units: &[u16]) -> &[u16] {
    while let Some(&first) = units.first() {
        if is_js_whitespace_unit(first) {
            units = &units[1..];
        } else {
            break;
        }
    }
    while let Some(&last) = units.last() {
        if is_js_whitespace_unit(last) {
            units = &units[..units.len() - 1];
        } else {
            break;
        }
    }
    units
}

fn starts_with_ascii(units: &[u16], prefix: &str) -> bool {
    let bytes = prefix.as_bytes();
    if units.len() < bytes.len() {
        return false;
    }
    units
        .iter()
        .zip(bytes.iter())
        .all(|(&u, &b)| u == u16::from(b))
}

fn ends_with_ascii(units: &[u16], suffix: &str) -> bool {
    let bytes = suffix.as_bytes();
    if units.len() < bytes.len() {
        return false;
    }
    let start = units.len() - bytes.len();
    units[start..]
        .iter()
        .zip(bytes.iter())
        .all(|(&u, &b)| u == u16::from(b))
}

fn eq_ascii(units: &[u16], literal: &str) -> bool {
    units.len() == literal.len() && starts_with_ascii(units, literal)
}

/// Parses `adb devices -l` lines leniently (`adb-transports.ts:32-62`).
pub fn adb_transports(output: &JsString) -> Result<Vec<AdbTransport>, DeviceError> {
    let all_units: Vec<u16> = output.units().collect();
    let mut result = Vec::new();
    for raw in all_units.split(|&u| u == u16::from(b'\n')) {
        let line = trim_units(raw);
        if line.is_empty()
            || starts_with_ascii(line, "List of devices")
            || starts_with_ascii(line, "*")
        {
            continue;
        }
        // /^(\S{1,200})\s+(.*)$/
        let Some(ws_pos) = line.iter().position(|&u| is_js_whitespace_unit(u)) else {
            continue;
        };
        if ws_pos == 0 || ws_pos > MAX_SERIAL_UTF16 {
            continue;
        }
        let serial_units = &line[..ws_pos];
        let after_serial = &line[ws_pos..];
        let rest_start = after_serial
            .iter()
            .position(|&u| !is_js_whitespace_unit(u))
            .unwrap_or(after_serial.len());
        let rest = &after_serial[rest_start..];
        if result.len() >= MAX_TRANSPORTS {
            let text = &crate::catalog::devices_catalog()
                .adb_transports
                .too_many_transports;
            return Err(DeviceError::coded(
                DeviceErrorCode::Limit,
                text.message.as_str(),
                text.hint.as_str(),
            ));
        }

        let (model_raw, usb_raw) = parse_props(rest);
        let model = model_raw.and_then(|units| {
            if units.is_empty() {
                None
            } else {
                let replaced: Vec<u16> = units
                    .iter()
                    .take(MAX_MODEL_UTF16)
                    .map(|&u| {
                        if u == u16::from(b'_') {
                            u16::from(b' ')
                        } else {
                            u
                        }
                    })
                    .collect();
                Some(JsString::from_units(&replaced))
            }
        });
        let usb = usb_raw.and_then(|units| {
            if units.is_empty() {
                None
            } else {
                Some(JsString::from_units(units))
            }
        });

        let (state, block) = transport_state_units(rest);
        let kind = transport_kind_units(serial_units);
        result.push(AdbTransport {
            serial: JsString::from_units(serial_units),
            kind,
            state,
            block,
            model,
            usb,
        });
    }
    Ok(result)
}

/// Scans `/(?:^|\s)(usb|product|model|device|transport_id):(\S+)/g` on `rest`.
fn parse_props(rest: &[u16]) -> (Option<&[u16]>, Option<&[u16]>) {
    let mut model: Option<&[u16]> = None;
    let mut usb: Option<&[u16]> = None;
    let mut i = 0;
    while i < rest.len() {
        while i < rest.len() && is_js_whitespace_unit(rest[i]) {
            i += 1;
        }
        let start = i;
        while i < rest.len() && !is_js_whitespace_unit(rest[i]) {
            i += 1;
        }
        let token = &rest[start..i];
        if let Some(colon) = token.iter().position(|&u| u == u16::from(b':')) {
            let key = &token[..colon];
            let val = &token[colon + 1..];
            if !val.is_empty() {
                if eq_ascii(key, "model") {
                    model = Some(val);
                } else if eq_ascii(key, "usb") {
                    usb = Some(val);
                }
            }
        }
    }
    (model, usb)
}

fn transport_kind_units(serial: &[u16]) -> AdbTransportKind {
    // /^emulator-\d{4,5}$/
    if starts_with_ascii(serial, "emulator-") {
        let digits = &serial["emulator-".len()..];
        if (4..=5).contains(&digits.len())
            && digits
                .iter()
                .all(|&u| (u16::from(b'0')..=u16::from(b'9')).contains(&u))
        {
            return AdbTransportKind::Emulator;
        }
    }
    // /:\d{1,5}$/
    if let Some(colon) = serial.iter().rposition(|&u| u == u16::from(b':')) {
        let port = &serial[colon + 1..];
        if (1..=5).contains(&port.len())
            && port
                .iter()
                .all(|&u| (u16::from(b'0')..=u16::from(b'9')).contains(&u))
        {
            return AdbTransportKind::Network;
        }
    }
    // /\._adb(?:-tls-connect)?\._tcp\.?$/
    let trimmed_dot = if serial.last() == Some(&u16::from(b'.')) {
        &serial[..serial.len() - 1]
    } else {
        serial
    };
    if ends_with_ascii(trimmed_dot, "._adb._tcp")
        || ends_with_ascii(trimmed_dot, "._adb-tls-connect._tcp")
    {
        return AdbTransportKind::Network;
    }
    AdbTransportKind::Usb
}

/// What an adb serial names: an emulator here, a device on the network, else one on USB.
pub fn transport_kind(serial: &JsString) -> AdbTransportKind {
    let units: Vec<u16> = serial.units().collect();
    transport_kind_units(&units)
}

fn transport_state_units(rest: &[u16]) -> (DeviceState, Option<AdbBlock>) {
    let word_end = rest
        .iter()
        .position(|&u| is_js_whitespace_unit(u))
        .unwrap_or(rest.len());
    let word = &rest[..word_end];
    if eq_ascii(word, "device") {
        return (DeviceState::Booted, None);
    }
    if eq_ascii(word, "unauthorized") || eq_ascii(word, "authorizing") {
        return (DeviceState::Unauthorized, Some(AdbBlock::Unauthorized));
    }
    if starts_with_ascii(rest, "no permissions") {
        return (DeviceState::Unauthorized, Some(AdbBlock::NoPermissions));
    }
    (DeviceState::Offline, None)
}

/// The id part after `android:` for a non-emulator device (`adb-transports.ts:88-96`).
pub fn physical_id_part(
    serial: &JsString,
    usb: Option<&JsString>,
    serialno: Option<&JsString>,
) -> JsString {
    let source_units: Vec<u16> = if let Some(s) = serialno {
        s.units().collect()
    } else {
        let serial_units: Vec<u16> = serial.units().collect();
        let all_questions =
            !serial_units.is_empty() && serial_units.iter().all(|&u| u == u16::from(b'?'));
        if all_questions
            && let Some(usb_str) = usb
            && !usb_str.is_empty()
        {
            let mut combined: Vec<u16> = "usb-".encode_utf16().collect();
            combined.extend(usb_str.units());
            combined
        } else {
            serial_units
        }
    };
    let sanitized: Vec<u16> = source_units
        .into_iter()
        .take(MAX_SERIAL_UTF16)
        .map(|u| {
            if matches!(
                u,
                0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | 0x5f | 0x2e | 0x2d
            ) {
                u
            } else {
                u16::from(b'_')
            }
        })
        .collect();
    if sanitized.is_empty() {
        JsString::from("device")
    } else {
        JsString::from_units(&sanitized)
    }
}

/// `ro.serialno` as getprop prints it, when valid (`adb-transports.ts:99-102`).
pub fn hardware_serial(output: &JsString) -> Option<JsString> {
    let units: Vec<u16> = output.units().collect();
    let first_line = units
        .split(|&u| u == u16::from(b'\n'))
        .next()
        .unwrap_or(&[]);
    let trimmed = trim_units(first_line);
    if trimmed.is_empty() || trimmed.len() > MAX_SERIAL_UTF16 {
        return None;
    }
    if !trimmed.iter().all(|&u| (0x21..=0x7e).contains(&u)) {
        return None;
    }
    if eq_ascii(trimmed, "unknown") {
        return None;
    }
    Some(JsString::from_units(trimmed))
}

/// What a person calls a non-emulator Android device (`adb-transports.ts:105-108`).
pub fn physical_name(transport: &AdbTransport) -> JsString {
    if let Some(model) = &transport.model
        && !model.is_empty()
    {
        return model.clone();
    }
    if transport.kind == AdbTransportKind::Network {
        transport.serial.clone()
    } else {
        JsString::from(
            crate::catalog::devices_catalog()
                .adb_transports
                .default_physical_name
                .as_str(),
        )
    }
}

/// Why a blocked device can't be used, and what the person does about it (`adb-transports.ts:111-135`).
pub fn blocked_error(
    kind: AdbTransportKind,
    block: Option<AdbBlock>,
    name: &JsString,
    platform: &str,
) -> DeviceError {
    let blocked = &crate::catalog::devices_catalog().adb_transports.blocked;
    if block == Some(AdbBlock::NoPermissions) {
        let mut msg = name.clone();
        msg.push_js(&JsString::from(
            blocked.no_permissions.message_suffix.as_str(),
        ));
        let hint = if platform == "linux" {
            blocked.no_permissions.hint_linux.as_str()
        } else {
            blocked.no_permissions.hint_other.as_str()
        };
        return DeviceError::coded(DeviceErrorCode::PermissionDenied, msg, hint);
    }
    if kind == AdbTransportKind::Network {
        let mut msg = name.clone();
        msg.push_js(&JsString::from(blocked.network.message_suffix.as_str()));
        return DeviceError::coded(
            DeviceErrorCode::PermissionDenied,
            msg,
            blocked.network.hint.as_str(),
        );
    }
    let mut msg = name.clone();
    msg.push_js(&JsString::from(blocked.usb.message_suffix.as_str()));
    DeviceError::coded(
        DeviceErrorCode::PermissionDenied,
        msg,
        blocked.usb.hint.as_str(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Moved (b) case from `packages/devices/src/adb-transports.test.ts:4-33`.
    #[test]
    fn every_adb_state_reads_as_booted_offline_or_unauthorized_and_unknown_ones_are_kept_as_offline()
     {
        let output = JsString::from(
            [
                "* daemon not running; starting now at tcp:5037",
                "* daemon started successfully",
                "List of devices attached",
                "emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 transport_id:1",
                "R58M123ABC             authorizing usb:1-1 transport_id:2",
                "HT7A1A02345            recovery usb:1-2 product:marlin transport_id:3",
                "[fe80::1]:5555         connecting",
                "adb-HT7A1-AbC._adb._tcp sideload",
                "0A1B2C3D               future-state usb:2-1",
                "ZY22                   no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:2-2 transport_id:9",
            ]
            .join("\n"),
        );
        let listed = adb_transports(&output);
        assert_eq!(
            listed,
            Ok(vec![
                AdbTransport {
                    serial: JsString::from("emulator-5554"),
                    kind: AdbTransportKind::Emulator,
                    state: DeviceState::Booted,
                    block: None,
                    model: Some(JsString::from("sdk gphone64 x86 64")),
                    usb: None,
                },
                AdbTransport {
                    serial: JsString::from("R58M123ABC"),
                    kind: AdbTransportKind::Usb,
                    state: DeviceState::Unauthorized,
                    block: Some(AdbBlock::Unauthorized),
                    model: None,
                    usb: Some(JsString::from("1-1")),
                },
                AdbTransport {
                    serial: JsString::from("HT7A1A02345"),
                    kind: AdbTransportKind::Usb,
                    state: DeviceState::Offline,
                    block: None,
                    model: None,
                    usb: Some(JsString::from("1-2")),
                },
                AdbTransport {
                    serial: JsString::from("[fe80::1]:5555"),
                    kind: AdbTransportKind::Network,
                    state: DeviceState::Offline,
                    block: None,
                    model: None,
                    usb: None,
                },
                AdbTransport {
                    serial: JsString::from("adb-HT7A1-AbC._adb._tcp"),
                    kind: AdbTransportKind::Network,
                    state: DeviceState::Offline,
                    block: None,
                    model: None,
                    usb: None,
                },
                AdbTransport {
                    serial: JsString::from("0A1B2C3D"),
                    kind: AdbTransportKind::Usb,
                    state: DeviceState::Offline,
                    block: None,
                    model: None,
                    usb: Some(JsString::from("2-1")),
                },
                AdbTransport {
                    serial: JsString::from("ZY22"),
                    kind: AdbTransportKind::Usb,
                    state: DeviceState::Unauthorized,
                    block: Some(AdbBlock::NoPermissions),
                    model: None,
                    usb: Some(JsString::from("2-2")),
                },
            ])
        );
    }

    /// Moved (b) case from `packages/devices/src/adb-transports.test.ts:35-39`.
    #[test]
    fn device_ids_keep_to_the_characters_ids_allow_so_an_address_still_names_one_device() {
        assert_eq!(
            physical_id_part(&JsString::from("[fe80::1]:5555"), None, None),
            JsString::from("_fe80__1__5555")
        );
        assert_eq!(
            physical_id_part(&JsString::from("192.168.1.5:5555"), None, None),
            JsString::from("192.168.1.5_5555")
        );
        assert_eq!(
            physical_id_part(
                &JsString::from("192.168.1.5:5555"),
                None,
                Some(&JsString::from("R58M123ABC"))
            ),
            JsString::from("R58M123ABC")
        );
    }

    #[test]
    fn question_mark_serial_with_usb_port_uses_usb_prefix_and_empty_falls_back_to_device() {
        assert_eq!(
            physical_id_part(
                &JsString::from("????????????"),
                Some(&JsString::from("3-1")),
                None
            ),
            JsString::from("usb-3-1")
        );
        assert_eq!(
            physical_id_part(&JsString::from("abc"), None, Some(&JsString::from(""))),
            JsString::from("device")
        );
    }

    #[test]
    fn transport_limit_rejects_above_128_connected_devices() {
        let lines: String = (0..129).map(|i| format!("SER{i:04} device\n")).collect();
        let err = adb_transports(&JsString::from(lines));
        assert!(matches!(
            err,
            Err(DeviceError::Coded {
                code: DeviceErrorCode::Limit,
                ..
            })
        ));
    }

    #[test]
    fn model_slicing_and_lone_surrogates_count_utf16_code_units() {
        // 127 ASCII 'a' + 1 surrogate pair (2 UTF-16 units) -> slice(0, 128) keeps the high surrogate.
        let mut units: Vec<u16> = "SER1 device model:".encode_utf16().collect();
        units.extend(std::iter::repeat_n(u16::from(b'a'), 127));
        units.push(0xd83d);
        units.push(0xde00);
        let input = JsString::from_units(&units);
        let parsed = adb_transports(&input);
        let Ok(list) = parsed else {
            panic!("expected Ok");
        };
        assert_eq!(list.len(), 1);
        let model = list[0].model.as_ref();
        assert_eq!(model.map(JsString::len_utf16), Some(128));
        assert_eq!(model.map(|m| m.units().last()), Some(Some(0xd83d)));
    }

    #[test]
    fn hardware_serial_accepts_printable_ascii_and_rejects_unknown_or_blank() {
        assert_eq!(
            hardware_serial(&JsString::from("R58M123ABC\r\n14\n")),
            Some(JsString::from("R58M123ABC"))
        );
        assert_eq!(hardware_serial(&JsString::from("unknown\n")), None);
        assert_eq!(hardware_serial(&JsString::from("   \n")), None);
        assert_eq!(hardware_serial(&JsString::from("bad serial\n")), None);
    }

    #[test]
    fn blocked_and_limit_errors_come_from_devices_catalog() {
        let catalog = &crate::catalog::devices_catalog().adb_transports;
        let usb_err = blocked_error(
            AdbTransportKind::Usb,
            Some(AdbBlock::Unauthorized),
            &JsString::from("Pixel 9"),
            "darwin",
        );
        assert!(matches!(
            usb_err,
            DeviceError::Coded { ref message, ref hint, .. }
                if message.to_string_lossy() == format!("Pixel 9{}", catalog.blocked.usb.message_suffix)
                    && hint.to_string_lossy() == catalog.blocked.usb.hint
        ));

        let linux_perm = blocked_error(
            AdbTransportKind::Usb,
            Some(AdbBlock::NoPermissions),
            &JsString::from("Pixel 9"),
            "linux",
        );
        assert!(matches!(
            linux_perm,
            DeviceError::Coded { ref hint, .. }
                if hint.to_string_lossy() == catalog.blocked.no_permissions.hint_linux
        ));

        let net_err = blocked_error(
            AdbTransportKind::Network,
            Some(AdbBlock::Unauthorized),
            &JsString::from("192.168.1.5:5555"),
            "darwin",
        );
        assert!(matches!(
            net_err,
            DeviceError::Coded { ref hint, .. }
                if hint.to_string_lossy() == catalog.blocked.network.hint
        ));

        let many: String = (0..=MAX_TRANSPORTS)
            .map(|i| format!("SER{i:03} device\n"))
            .collect();
        let err = adb_transports(&JsString::from(many.as_str()));
        assert!(matches!(
            err,
            Err(DeviceError::Coded { ref message, ref hint, .. })
                if message.to_string_lossy() == catalog.too_many_transports.message
                    && hint.to_string_lossy() == catalog.too_many_transports.hint
        ));
    }
}
