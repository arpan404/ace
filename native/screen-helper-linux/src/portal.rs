//! Portal session persistence is owned by RemoteDesktop for a combined session.
use crate::{
    policy::portal_policy,
    protocol::{Fault, Result, internal},
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf};
use zbus::{
    Connection, Proxy,
    zvariant::{OwnedObjectPath, OwnedValue, Value as DValue},
};
type Dict = HashMap<String, OwnedValue>;
const SERVICE: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
fn dict(entries: impl IntoIterator<Item = (&'static str, OwnedValue)>) -> Dict {
    entries.into_iter().map(|(k, v)| (k.into(), v)).collect()
}
fn string(s: &str) -> Result<OwnedValue> {
    OwnedValue::try_from(DValue::from(s)).map_err(internal)
}
pub struct Portal {
    conn: Connection,
    pub session: Option<OwnedObjectPath>,
    pub node: u32,
    pub size: (u32, u32),
    pub devices: u32,
    pub sources: u32,
    pub version: u32,
    token_path: PathBuf,
    counter: u64,
}
impl Portal {
    pub async fn connect(token_path: PathBuf) -> Result<Self> {
        let conn = Connection::session().await.map_err(internal)?;
        let sc = Proxy::new(&conn, SERVICE, PATH, "org.freedesktop.portal.ScreenCast")
            .await
            .map_err(internal)?;
        let rd = Proxy::new(&conn, SERVICE, PATH, "org.freedesktop.portal.RemoteDesktop")
            .await
            .map_err(internal)?;
        let sources: u32 = sc.get_property("AvailableSourceTypes").await.map_err(|e| {
            Fault::new(
                "not_supported",
                format!("ScreenCast portal unavailable: {e}"),
            )
        })?;
        let devices: u32 = rd.get_property("AvailableDeviceTypes").await.map_err(|e| {
            Fault::new(
                "not_supported",
                format!("RemoteDesktop portal unavailable: {e}"),
            )
        })?;
        let version: u32 = rd.get_property("version").await.map_err(internal)?;
        Ok(Self {
            conn,
            session: None,
            node: 0,
            size: (0, 0),
            devices,
            sources,
            version,
            token_path,
            counter: 0,
        })
    }
    pub fn capabilities(&self, ui: bool) -> Value {
        let p = portal_policy(self.sources, self.devices, self.version);
        let permission = if self.session.is_some() {
            "granted"
        } else {
            "prompt"
        };
        json!({"version":2,"platform":"linux-wayland","capture":{"windows":p.windows,"displays":p.displays,"changeDriven":false},"input":{"pointer":p.pointer,"keyboard":p.keyboard,"scroll":p.pointer,"text":ui},"uiTree":ui,"semanticActions":if ui {vec!["press","focus","setValue","scroll","expand","select"]} else {vec![]},"codecs":["jpeg"],"permissions":{"screen":permission,"input":permission},"portal":{"remoteDesktopVersion":self.version,"restore":p.persistent,"desktop":std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default(),"windowIdentity":false,"semanticScope":"approved executable with exactly one accessible window, independent of chooser","notes":"Window availability and restore support vary by GNOME/KDE portal version; chooser controls source, no EWMH ids or silent window targeting"}})
    }
    async fn proxy(&self, interface: &str) -> Result<Proxy<'_>> {
        Proxy::new(
            &self.conn,
            SERVICE,
            PATH,
            format!("org.freedesktop.portal.{interface}"),
        )
        .await
        .map_err(internal)
    }
    async fn request(
        &mut self,
        interface: &str,
        method: &str,
        session: Option<&OwnedObjectPath>,
        mut options: Dict,
    ) -> Result<Dict> {
        self.counter += 1;
        let token = format!("ace{}", self.counter);
        options.insert("handle_token".into(), string(&token)?);
        let sender = self
            .conn
            .unique_name()
            .ok_or_else(|| internal("No bus name"))?
            .as_str()
            .trim_start_matches(':')
            .replace('.', "_");
        let expected = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
        // Subscribe before invoking, since fast restored sessions can signal before the reply.
        let request = Proxy::new(
            &self.conn,
            SERVICE,
            expected.as_str(),
            "org.freedesktop.portal.Request",
        )
        .await
        .map_err(internal)?;
        let mut responses = request.receive_signal("Response").await.map_err(internal)?;
        let proxy = self.proxy(interface).await?;
        let handle: OwnedObjectPath = match method {
            "CreateSession" => proxy.call(method, &(options,)).await.map_err(internal)?,
            "Start" => proxy
                .call(
                    method,
                    &(session.ok_or_else(|| internal("No session"))?, "", options),
                )
                .await
                .map_err(internal)?,
            _ => proxy
                .call(
                    method,
                    &(session.ok_or_else(|| internal("No session"))?, options),
                )
                .await
                .map_err(internal)?,
        };
        if handle.as_str() != expected {
            return Err(Fault::new(
                "not_supported",
                "Portal returned an unexpected request handle",
            ));
        }
        let message =
            match tokio::time::timeout(std::time::Duration::from_secs(120), responses.next()).await
            {
                Ok(Some(m)) => m,
                _ => {
                    let _: std::result::Result<(), _> = request.call("Close", &()).await;
                    return Err(Fault::new("timeout", "Portal consent timed out"));
                }
            };
        let (code, results): (u32, Dict) = message.body().deserialize().map_err(internal)?;
        if code != 0 {
            return Err(Fault::new(
                "permission_denied",
                "Portal consent was cancelled or denied",
            ));
        }
        Ok(results)
    }
    pub async fn start(&mut self, window: bool) -> Result<std::os::fd::OwnedFd> {
        if self.session.is_some() {
            return Err(Fault::new("busy", "Portal session already active"));
        }
        let source = if window { 2 } else { 1 };
        if self.sources & source == 0 {
            return Err(Fault::new(
                "not_supported",
                "Compositor cannot capture this source type",
            ));
        }
        let created = self
            .request(
                "RemoteDesktop",
                "CreateSession",
                None,
                dict([("session_handle_token", string("ace_session")?)]),
            )
            .await?;
        let path: String = created
            .get("session_handle")
            .ok_or_else(|| internal("Portal omitted session"))?
            .try_clone()
            .map_err(internal)?
            .try_into()
            .map_err(internal)?;
        let session = OwnedObjectPath::try_from(path).map_err(internal)?;
        self.session = Some(session.clone());
        let result = self.configure(&session, source).await;
        if result.is_err() {
            let _ = self.stop().await;
        }
        result
    }
    async fn configure(
        &mut self,
        session: &OwnedObjectPath,
        source: u32,
    ) -> Result<std::os::fd::OwnedFd> {
        let mut options = dict([("types", OwnedValue::from(self.devices & 3))]);
        if self.version >= 2 {
            options.insert("persist_mode".into(), OwnedValue::from(2u32));
            if let Some(token) = read_token(&self.token_path)? {
                options.insert("restore_token".into(), string(&token)?);
            }
        }
        self.request("RemoteDesktop", "SelectDevices", Some(session), options)
            .await?;
        // Combined sessions must not pass persistence options to ScreenCast.
        self.request(
            "ScreenCast",
            "SelectSources",
            Some(session),
            dict([
                ("types", OwnedValue::from(source)),
                ("multiple", OwnedValue::from(false)),
                ("cursor_mode", OwnedValue::from(1u32)),
            ]),
        )
        .await?;
        let result = self
            .request("RemoteDesktop", "Start", Some(session), HashMap::new())
            .await?;
        self.devices = result
            .get("devices")
            .ok_or_else(|| internal("Portal omitted devices"))?
            .try_clone()
            .map_err(internal)?
            .try_into()
            .map_err(internal)?;
        let streams: Vec<(u32, Dict)> = result
            .get("streams")
            .ok_or_else(|| internal("Portal omitted streams"))?
            .try_clone()
            .map_err(internal)?
            .try_into()
            .map_err(internal)?;
        if streams.len() != 1 {
            return Err(Fault::new(
                "not_supported",
                "Exactly one portal source is required",
            ));
        }
        let (node, props) = streams
            .into_iter()
            .next()
            .ok_or_else(|| internal("No streams"))?;
        self.node = node;
        let (w, h): (i32, i32) = props
            .get("size")
            .ok_or_else(|| {
                Fault::new(
                    "not_supported",
                    "Portal omitted logical size; cannot map input safely",
                )
            })?
            .try_clone()
            .map_err(internal)?
            .try_into()
            .map_err(internal)?;
        if w <= 0 || h <= 0 || w > 8192 || h > 8192 {
            return Err(Fault::new("bounds", "Invalid portal size"));
        }
        self.size = (w as u32, h as u32);
        if let Some(value) = result.get("restore_token") {
            let token: String = value
                .try_clone()
                .map_err(internal)?
                .try_into()
                .map_err(internal)?;
            save_token(&self.token_path, &token)?;
        } else if self.token_path.exists() {
            std::fs::remove_file(&self.token_path).map_err(internal)?;
        }
        let fd: zbus::zvariant::OwnedFd = self
            .proxy("ScreenCast")
            .await?
            .call("OpenPipeWireRemote", &(session, Dict::new()))
            .await
            .map_err(internal)?;
        Ok(fd.into())
    }
    pub async fn stop(&mut self) -> Result<()> {
        if let Some(path) = self.session.take() {
            let proxy = Proxy::new(
                &self.conn,
                SERVICE,
                path.as_str(),
                "org.freedesktop.portal.Session",
            )
            .await
            .map_err(internal)?;
            proxy
                .call::<_, _, ()>("Close", &())
                .await
                .map_err(internal)?;
        }
        Ok(())
    }
    pub async fn motion(&self, x: f64, y: f64) -> Result<()> {
        crate::policy::point(x, y, self.size.0, self.size.1)?;
        self.require(2)?;
        self.proxy("RemoteDesktop")
            .await?
            .call::<_, _, ()>(
                "NotifyPointerMotionAbsolute",
                &(self.path()?, Dict::new(), self.node, x, y),
            )
            .await
            .map_err(internal)
    }
    pub async fn button(&self, button: &str, pressed: bool) -> Result<()> {
        self.require(2)?;
        let code: i32 = match button {
            "left" => 0x110,
            "right" => 0x111,
            "middle" => 0x112,
            _ => return Err(Fault::new("bounds", "Unknown button")),
        };
        self.proxy("RemoteDesktop")
            .await?
            .call::<_, _, ()>(
                "NotifyPointerButton",
                &(self.path()?, Dict::new(), code, u32::from(pressed)),
            )
            .await
            .map_err(internal)
    }
    pub async fn key_symbol(&self, symbol: u32, pressed: bool) -> Result<()> {
        self.require(1)?;
        self.proxy("RemoteDesktop")
            .await?
            .call::<_, _, ()>(
                "NotifyKeyboardKeysym",
                &(self.path()?, Dict::new(), symbol as i32, u32::from(pressed)),
            )
            .await
            .map_err(internal)
    }
    pub async fn scroll(&self, dx: f64, dy: f64) -> Result<()> {
        if !dx.is_finite() || !dy.is_finite() || dx.abs() > 1000. || dy.abs() > 1000. {
            return Err(Fault::new("bounds", "Scroll exceeds limit"));
        }
        self.require(2)?;
        self.proxy("RemoteDesktop")
            .await?
            .call::<_, _, ()>(
                "NotifyPointerAxis",
                &(
                    self.path()?,
                    dict([("finish", OwnedValue::from(true))]),
                    dx,
                    dy,
                ),
            )
            .await
            .map_err(internal)
    }
    fn path(&self) -> Result<&OwnedObjectPath> {
        self.session
            .as_ref()
            .ok_or_else(|| Fault::new("target_gone", "No portal session"))
    }
    fn require(&self, device: u32) -> Result<()> {
        self.path()?;
        if self.devices & device == 0 {
            return Err(Fault::new(
                "permission_denied",
                "Portal did not grant this input device",
            ));
        }
        Ok(())
    }
}
pub use crate::portal_token::{read_token, save_token};
