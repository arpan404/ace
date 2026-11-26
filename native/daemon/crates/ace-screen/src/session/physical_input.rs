// SPDX-License-Identifier: Apache-2.0

//! The person's own keyboard and mouse on this Mac or Windows machine (`computer/physical-input.ts`,
//! ADR 0143): the time since the last HID event, and the app the helper says is frontmost. The
//! ports are injected: `ioreg` on macOS, the helper's `physical_input` op on Windows, and the
//! same monotonic clock cowork leases and deadlines use.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use ace_json::{JsString, Value};

/// The largest idle value Windows' GetLastInputInfo reports (`0xffff_ffff`).
const WINDOWS_IDLE_MAX: f64 = 4_294_967_295.0;

/// One port's future.
pub type PortFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// The idle time `ioreg -c IOHIDSystem` reports, in whole ms (`physical-input.ts:14`);
/// `None` when the output has none. macOS keeps it in nanoseconds.
pub fn hid_idle_ms(ioreg: &str) -> Option<f64> {
    let at = ioreg.find("\"HIDIdleTime\"")?;
    let rest = &ioreg[at + "\"HIDIdleTime\"".len()..];
    let equals = rest.find('=')?;
    let digits: String = rest[equals + 1..]
        .chars()
        .skip_while(|character| character.is_whitespace())
        .take_while(|character| character.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    // `BigInt(idle) / 1_000_000n`: whole milliseconds, never rounded up.
    let nanos: u128 = digits.parse().ok()?;
    Some((nanos / 1_000_000) as f64)
}

/// The frontmost app among those the computer-use helper lists (`physical-input.ts:19`), if it
/// says. The reply decodes leniently: unknown fields stay, a malformed one means nothing.
pub fn frontmost_app(apps: Option<&Value>) -> Option<JsString> {
    let list = apps?.as_object()?.get("apps")?.as_array()?;
    for app in list.iter() {
        let app = app.as_object()?;
        if !app.get("bundleId").is_some_and(Value::is_string) {
            return None;
        }
        if !app.get("running").is_some_and(Value::is_boolean) {
            return None;
        }
        if app.get("active").and_then(Value::as_bool) == Some(true) {
            return app
                .get("bundleId")
                .and_then(Value::as_str)
                .map(JsString::from);
        }
    }
    None
}

/// The last input is the clock minus the idle time, when the helper reported one.
fn last_input_at(now: f64, idle_ms: Option<f64>) -> Option<f64> {
    idle_ms.map(|idle| now - idle)
}

/// Windows' `physical_input` reply: filtered idle milliseconds, `0..=u32::MAX`.
pub fn windows_idle_ms(reply: Option<&Value>) -> Option<f64> {
    reply
        .and_then(Value::as_object)
        .and_then(|fields| fields.get("idleMs"))
        .and_then(Value::as_f64)
        .filter(|idle| idle.fract() == 0.0 && *idle >= 0.0 && *idle <= WINDOWS_IDLE_MAX)
}

/// The ports macOS input needs (`MacPhysicalInputPorts`, `physical-input.ts:26`).
#[derive(Clone)]
pub struct MacPorts {
    /// The same monotonic millisecond clock used for cowork leases and deadlines.
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
    /// Runs `ioreg` with these arguments and returns its output.
    pub ioreg: Arc<dyn Fn(Vec<String>) -> PortFuture<String> + Send + Sync>,
    /// The computer-use helper's `apps` reply, or `None` while there is no helper.
    pub apps: Arc<dyn Fn() -> PortFuture<Option<Value>> + Send + Sync>,
}

/// The person's keyboard and mouse, as the cowork rules ask about them.
pub struct MacPhysicalInput {
    ports: MacPorts,
}

impl MacPhysicalInput {
    pub fn new(ports: MacPorts) -> Self {
        Self { ports }
    }

    pub async fn last_input_at(&self) -> Option<f64> {
        let args = vec![
            "-c".to_owned(),
            "IOHIDSystem".to_owned(),
            "-d".to_owned(),
            "4".to_owned(),
            "-r".to_owned(),
        ];
        let idle = hid_idle_ms(&(self.ports.ioreg)(args).await);
        last_input_at((self.ports.now)(), idle)
    }

    pub async fn frontmost(&self) -> Option<JsString> {
        frontmost_app((self.ports.apps)().await.as_ref())
    }
}

/// The ports Windows input needs (`WindowsPhysicalInputPorts`, `physical-input.ts:50`).
#[derive(Clone)]
pub struct WindowsPorts {
    /// The same monotonic millisecond clock used for cowork leases and deadlines.
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
    /// The helper's `physical_input` reply.
    pub idle: Arc<dyn Fn() -> PortFuture<Option<Value>> + Send + Sync>,
    /// The computer-use helper's `apps` reply, or `None` while there is no helper.
    pub apps: Arc<dyn Fn() -> PortFuture<Option<Value>> + Send + Sync>,
}

/// Windows' session-local input clock, attributed to the helper's frontmost app.
pub struct WindowsPhysicalInput {
    ports: WindowsPorts,
}

impl WindowsPhysicalInput {
    pub fn new(ports: WindowsPorts) -> Self {
        Self { ports }
    }

    pub async fn last_input_at(&self) -> Option<f64> {
        let reply = (self.ports.idle)().await;
        last_input_at((self.ports.now)(), windows_idle_ms(reply.as_ref()))
    }

    pub async fn frontmost(&self) -> Option<JsString> {
        frontmost_app((self.ports.apps)().await.as_ref())
    }
}

#[cfg(test)]
// The `computer/physical-input` cases, moved from TypeScript
// (`packages/screen/src/computer/physical-input.test.ts`): `ioreg`'s idle time reads as ms
// (`:11`), the last input is now minus the idle time and the frontmost app is the helper's
// active one (`:18`), Windows attributes session input to that app (`:36`), and a malformed
// idle reply is nothing (`:53`).
mod tests {
    use std::sync::Arc;

    use ace_json::json;

    use super::{
        MacPhysicalInput, MacPorts, WindowsPhysicalInput, WindowsPorts, frontmost_app, hid_idle_ms,
        windows_idle_ms,
    };

    /// `physical-input.test.ts:11`.
    #[test]
    fn ioregs_idle_time_reads_as_milliseconds() {
        assert_eq!(
            hid_idle_ms("  |   \"HIDIdleTime\" = 2500000000"),
            Some(2_500.0)
        );
        assert_eq!(hid_idle_ms("\"HIDIdleTime\"=0"), Some(0.0));
        assert_eq!(hid_idle_ms("no idle entry"), None);
    }

    /// `physical-input.test.ts:18`.
    #[tokio::test]
    async fn the_last_input_is_now_minus_the_idle_time_and_the_frontmost_app_is_the_active_one() {
        let input = MacPhysicalInput::new(MacPorts {
            now: Arc::new(|| 10_000.0),
            ioreg: Arc::new(|_| Box::pin(async { "\"HIDIdleTime\" = 1500000000".to_owned() })),
            apps: Arc::new(|| {
                Box::pin(async {
                    Some(json!({
                        "apps": [
                            { "bundleId": "com.apple.Safari", "name": "Safari", "running": true },
                            { "bundleId": "com.apple.TextEdit", "name": "TextEdit", "running": true, "active": true }
                        ]
                    }))
                })
            }),
        });
        assert_eq!(input.last_input_at().await, Some(8_500.0));
        assert_eq!(
            input.frontmost().await.as_ref().map(|app| app.as_str()),
            Some("com.apple.TextEdit")
        );
        assert_eq!(frontmost_app(None), None);
    }

    /// `physical-input.test.ts:36`.
    #[tokio::test]
    async fn windows_attributes_recent_session_input_to_the_helpers_frontmost_app() {
        let now = Arc::new(std::sync::Mutex::new(10_000.0));
        let idle = Arc::new(std::sync::Mutex::new(750.0));
        let now_port = Arc::clone(&now);
        let idle_port = Arc::clone(&idle);
        let input = WindowsPhysicalInput::new(WindowsPorts {
            now: Arc::new(move || *now_port.lock().unwrap_or_else(|error| error.into_inner())),
            idle: Arc::new(move || {
                let idle = *idle_port.lock().unwrap_or_else(|error| error.into_inner());
                Box::pin(async move { Some(json!({ "idleMs": idle, "newerHelperField": true })) })
            }),
            apps: Arc::new(|| {
                Box::pin(async {
                    Some(json!({
                        "apps": [
                            { "bundleId": "notepad.exe", "name": "Notepad", "running": true },
                            { "bundleId": "CalculatorApp.exe", "name": "Calculator", "running": true, "active": true }
                        ]
                    }))
                })
            }),
        });
        assert_eq!(input.last_input_at().await, Some(9_250.0));
        assert_eq!(
            input.frontmost().await.as_ref().map(|app| app.as_str()),
            Some("CalculatorApp.exe")
        );
        *now.lock().unwrap_or_else(|error| error.into_inner()) = 12_000.0;
        *idle.lock().unwrap_or_else(|error| error.into_inner()) = 100.0;
        assert_eq!(input.last_input_at().await, Some(11_900.0));
    }

    /// `physical-input.test.ts:53`.
    #[test]
    fn a_malformed_windows_idle_reply_is_nothing() {
        for reply in [
            None,
            Some(json!({})),
            Some(json!({ "idleMs": null })),
            Some(json!({ "idleMs": -1 })),
            Some(json!({ "idleMs": "100" })),
            Some(json!({ "idleMs": 4_294_967_296.0 })),
        ] {
            assert_eq!(windows_idle_ms(reply.as_ref()), None, "{reply:?}");
        }
        assert_eq!(windows_idle_ms(Some(&json!({ "idleMs": 0 }))), Some(0.0));
    }
}
