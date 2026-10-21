//! The AT-SPI bus: one connection, every call bounded so a hung app costs at most a second.
use crate::computer::error::{CuError, CuResult};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use zbus::Connection;
use zbus::zvariant::{DynamicType, OwnedObjectPath, OwnedValue, Type, Value};

/// An accessible object: the app's unique bus name and the object path.
pub type Obj = (String, OwnedObjectPath);

pub const CALL_TIMEOUT: Duration = Duration::from_millis(1000);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BusError {
    /// The app did not answer in time: it is hung or busy.
    Timeout,
    /// The object or app is gone, or refused the call.
    Failed(String),
}

impl BusError {
    pub fn is_timeout(&self) -> bool {
        matches!(self, BusError::Timeout)
    }
}

pub type BusResult<T> = Result<T, BusError>;

pub fn key(obj: &Obj) -> String {
    format!("{}{}", obj.0, obj.1.as_str())
}

pub fn path(text: &str) -> OwnedObjectPath {
    OwnedObjectPath::try_from(text).unwrap_or_else(|_| OwnedObjectPath::default())
}

/// A null reference: AT-SPI uses the path `/org/a11y/atspi/null` for "no object".
pub fn is_null(obj: &Obj) -> bool {
    obj.1.as_str().ends_with("/null") || obj.0.is_empty()
}

#[derive(Clone)]
pub struct Bus {
    pub conn: Connection,
}

impl Bus {
    /// Turns accessibility on for the session (as screen readers do, so apps started later
    /// expose trees) and connects to the accessibility bus.
    pub async fn connect() -> CuResult<Self> {
        let unavailable = |e: &dyn std::fmt::Display| {
            CuError::new(
                "permission_accessibility",
                format!(
                    "The accessibility bus (AT-SPI) is not reachable ({e}). Computer use needs a desktop session with at-spi2-core running; ask the person to install or enable it, then try again."
                ),
            )
        };
        let session = tokio::time::timeout(Duration::from_secs(3), Connection::session())
            .await
            .map_err(|e| unavailable(&e))?
            .map_err(|e| unavailable(&e))?;
        let body = ("org.a11y.Status", "IsEnabled", Value::from(true));
        let enable = session.call_method(
            Some("org.a11y.Bus"),
            "/org/a11y/bus",
            Some("org.freedesktop.DBus.Properties"),
            "Set",
            &body,
        );
        if let Ok(Err(e)) = tokio::time::timeout(Duration::from_secs(2), enable).await {
            eprintln!("computer: could not set org.a11y.Status.IsEnabled: {e}");
        }
        let address = tokio::time::timeout(
            Duration::from_secs(3),
            session.call_method(
                Some("org.a11y.Bus"),
                "/org/a11y/bus",
                Some("org.a11y.Bus"),
                "GetAddress",
                &(),
            ),
        )
        .await
        .map_err(|e| unavailable(&e))?
        .map_err(|e| unavailable(&e))?;
        let address: String = address.body().deserialize().map_err(|e| unavailable(&e))?;
        let builder = zbus::connection::Builder::address(address.as_str())
            .map_err(|e| unavailable(&e))?
            .method_timeout(CALL_TIMEOUT + Duration::from_millis(200));
        let conn = tokio::time::timeout(Duration::from_secs(3), builder.build())
            .await
            .map_err(|e| unavailable(&e))?
            .map_err(|e| unavailable(&e))?;
        Ok(Self { conn })
    }

    pub async fn call<B, R>(&self, obj: &Obj, interface: &str, method: &str, body: &B) -> BusResult<R>
    where
        B: Serialize + DynamicType,
        R: for<'d> Deserialize<'d> + Type,
    {
        let call = self
            .conn
            .call_method(Some(obj.0.as_str()), obj.1.as_str(), Some(interface), method, body);
        let reply = match tokio::time::timeout(CALL_TIMEOUT, call).await {
            Err(_) => return Err(BusError::Timeout),
            Ok(Err(e)) => return Err(classify(e)),
            Ok(Ok(reply)) => reply,
        };
        reply
            .body()
            .deserialize::<R>()
            .map_err(|e| BusError::Failed(e.to_string()))
    }

    pub async fn atspi<B, R>(&self, obj: &Obj, interface: &str, method: &str, body: &B) -> BusResult<R>
    where
        B: Serialize + DynamicType,
        R: for<'d> Deserialize<'d> + Type,
    {
        self.call(obj, &format!("org.a11y.atspi.{interface}"), method, body)
            .await
    }

    pub async fn prop(&self, obj: &Obj, interface: &str, name: &str) -> BusResult<OwnedValue> {
        let value: OwnedValue = self
            .call(
                obj,
                "org.freedesktop.DBus.Properties",
                "Get",
                &(format!("org.a11y.atspi.{interface}"), name),
            )
            .await?;
        Ok(value)
    }

    pub async fn set_prop(&self, obj: &Obj, interface: &str, name: &str, value: Value<'_>) -> BusResult<()> {
        self.call::<_, ()>(
            obj,
            "org.freedesktop.DBus.Properties",
            "Set",
            &(format!("org.a11y.atspi.{interface}"), name, value),
        )
        .await
    }

    pub async fn string_prop(&self, obj: &Obj, interface: &str, name: &str) -> BusResult<String> {
        let value = self.prop(obj, interface, name).await?;
        String::try_from(value).map_err(|e| BusError::Failed(e.to_string()))
    }

    pub async fn i32_prop(&self, obj: &Obj, interface: &str, name: &str) -> BusResult<i32> {
        let value = self.prop(obj, interface, name).await?;
        i32::try_from(value).map_err(|e| BusError::Failed(e.to_string()))
    }

    pub async fn f64_prop(&self, obj: &Obj, interface: &str, name: &str) -> BusResult<f64> {
        let value = self.prop(obj, interface, name).await?;
        f64::try_from(value).map_err(|e| BusError::Failed(e.to_string()))
    }

    /// The process behind a bus name.
    pub async fn pid_of(&self, bus_name: &str) -> Option<u32> {
        let obj = ("org.freedesktop.DBus".to_owned(), path("/org/freedesktop/DBus"));
        self.call::<_, u32>(&obj, "org.freedesktop.DBus", "GetConnectionUnixProcessID", &(bus_name,))
            .await
            .ok()
    }

    /// Accessible applications registered on the bus.
    pub async fn applications(&self) -> BusResult<Vec<Obj>> {
        let registry = (
            "org.a11y.atspi.Registry".to_owned(),
            path("/org/a11y/atspi/accessible/root"),
        );
        self.children(&registry).await
    }

    pub async fn children(&self, obj: &Obj) -> BusResult<Vec<Obj>> {
        match self.atspi::<_, Vec<Obj>>(obj, "Accessible", "GetChildren", &()).await {
            Ok(children) => Ok(children),
            Err(BusError::Timeout) => Err(BusError::Timeout),
            Err(_) => {
                let count = self.i32_prop(obj, "Accessible", "ChildCount").await?;
                let mut children = Vec::new();
                for index in 0..count.clamp(0, 2000) {
                    children.push(self.atspi(obj, "Accessible", "GetChildAtIndex", &(index,)).await?);
                }
                Ok(children)
            }
        }
    }

    /// Asks every app to send the events the settler and walker listen for.
    pub async fn register_events(&self) {
        let registry = ("org.a11y.atspi.Registry".to_owned(), path("/org/a11y/atspi/registry"));
        for event in ["object:", "window:", "focus:"] {
            let _ = self
                .call::<_, ()>(&registry, "org.a11y.atspi.Registry", "RegisterEvent", &(event,))
                .await;
        }
    }
}

fn classify(error: zbus::Error) -> BusError {
    match &error {
        zbus::Error::InputOutput(io) if io.kind() == std::io::ErrorKind::TimedOut => BusError::Timeout,
        zbus::Error::MethodError(name, _, _) if name.as_str().ends_with("NoReply") => BusError::Timeout,
        _ => BusError::Failed(error.to_string()),
    }
}
