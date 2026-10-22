//! The live view's Wayland portal session. Where the person can be given control (GNOME) it is
//! one combined RemoteDesktop session whose persistence RemoteDesktop owns. Elsewhere it is a
//! ScreenCast-only session that persists itself, and the view is watch-only with the reason
//! (`PortalRoute`): KDE's RemoteDesktop shares whole outputs whatever is picked, and
//! xdg-desktop-portal-hyprland and -wlr have no RemoteDesktop. Input never goes around the
//! portal (ADR 0049).
use crate::{
    policy::{
        PortalOffer, PortalRoute, RemoteDesktopOffer, portal_policy, portal_route, stream_matches,
    },
    portal_choice::{Picked, SOURCE_MONITOR, SOURCE_WINDOW},
    protocol::{Fault, Result, internal},
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64},
    },
};
use zbus::{
    Connection, Proxy,
    zvariant::{OwnedObjectPath, OwnedValue, Value as DValue},
};
pub(crate) type Dict = HashMap<String, OwnedValue>;
const SERVICE: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
/// How long closing a request or session may take before the helper moves on.
const CLOSE_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
pub(crate) fn dict(entries: impl IntoIterator<Item = (&'static str, OwnedValue)>) -> Dict {
    entries.into_iter().map(|(k, v)| (k.into(), v)).collect()
}
fn string(s: &str) -> Result<OwnedValue> {
    OwnedValue::try_from(DValue::from(s)).map_err(internal)
}
/// What the person may pick in the sharing dialog.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Choice {
    Window,
    Display,
    /// A window or a whole screen: the dialog offers both.
    Any,
}
/// Why a consent request ended without a session, in the person's words.
pub const DECLINED: &str = "Sharing was declined in the sharing dialog.";
pub const UNANSWERED: &str = "Nobody chose a window or screen in the sharing dialog within 2 minutes.";
pub struct Portal {
    pub(crate) conn: Connection,
    pub session: Option<OwnedObjectPath>,
    pub node: u32,
    pub size: (u32, u32),
    /// Input devices the person granted in the current session (none when watch-only).
    pub devices: u32,
    pub(crate) offer: PortalOffer,
    /// XDG_CURRENT_DESKTOP, which decides the route on KDE.
    desktop: String,
    /// What the person shared, once the session started.
    pub picked: Option<Picked>,
    /// Logical size of the newest picture (width << 32 | height), written by the capture thread.
    pub shown: Arc<AtomicU64>,
    pub(crate) pointer_ready: AtomicBool,
    pub(crate) keyboard_ready: AtomicBool,
    token_path: PathBuf,
    counter: u64,
}
impl Portal {
    pub async fn connect(token_path: PathBuf) -> Result<Self> {
        let conn = Connection::session().await.map_err(internal)?;
        let sc = Proxy::new(&conn, SERVICE, PATH, "org.freedesktop.portal.ScreenCast")
            .await
            .map_err(internal)?;
        let sources: u32 = sc.get_property("AvailableSourceTypes").await.map_err(|e| {
            Fault::new(
                "not_supported",
                format!("ScreenCast portal unavailable: {e}"),
            )
        })?;
        let screencast_version: u32 = sc.get_property("version").await.unwrap_or(1);
        let offer = PortalOffer {
            sources,
            screencast_version,
            remote_desktop: remote_desktop(&conn).await,
        };
        Ok(Self {
            conn,
            session: None,
            node: 0,
            size: (0, 0),
            devices: 0,
            offer,
            desktop: std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default(),
            picked: None,
            shown: Arc::new(AtomicU64::new(0)),
            pointer_ready: AtomicBool::new(false),
            keyboard_ready: AtomicBool::new(false),
            token_path,
            counter: 0,
        })
    }
    pub fn route(&self) -> PortalRoute {
        portal_route(&self.desktop, &self.offer)
    }
    pub fn capabilities(&self, ui: bool) -> Value {
        let route = self.route();
        let p = portal_policy(&self.offer, route);
        let screen = if self.session.is_some() {
            "granted"
        } else {
            "prompt"
        };
        let watch_only = match route {
            PortalRoute::RemoteDesktop => None,
            PortalRoute::ScreenCastOnly(reason) => Some(reason),
        };
        let input = if watch_only.is_some() { "n/a" } else { screen };
        // A whole screen is the person's alone: input could reach any app on it.
        let view_only = self.picked.as_ref().is_some_and(|p| p.display);
        let picked = self.picked.as_ref().map(Picked::json);
        let remote = self.offer.remote_desktop;
        json!({"version":2,"platform":"linux-wayland","capture":{"windows":p.windows,"displays":p.displays,"changeDriven":false},"input":{"pointer":p.pointer,"keyboard":p.keyboard,"scroll":p.pointer,"text":(ui && !view_only) || p.keyboard},"uiTree":ui,"semanticActions":if ui {vec!["press","focus","setValue","scroll","expand","select"]} else {vec![]},"codecs":["jpeg"],"permissions":{"screen":screen,"input":input},"watchOnly":watch_only,"portal":{"remoteDesktop":remote.is_some(),"remoteDesktopVersion":remote.map_or(0, |rd| rd.version),"screenCastVersion":self.offer.screencast_version,"restore":p.persistent,"desktop":self.desktop,"windowIdentity":false,"picked":picked,"semanticScope":"the app the person picked in the sharing dialog, when the desktop records it","notes":"The sharing dialog picks the source; there are no window ids to target. Person input only through RemoteDesktop where it reaches exactly what was shared (GNOME)"}})
    }
    pub(crate) async fn proxy(&self, interface: &str) -> Result<Proxy<'_>> {
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
                    // A backend still waiting on its chooser (xdg-desktop-portal-hyprland runs
                    // it synchronously) can't answer Close either: don't wait on it.
                    let close = request.call::<_, _, ()>("Close", &());
                    let _ = tokio::time::timeout(CLOSE_WAIT, close).await;
                    return Err(Fault::new("timeout", UNANSWERED));
                }
            };
        let (code, results): (u32, Dict) = message.body().deserialize().map_err(internal)?;
        if code != 0 {
            return Err(Fault::new("denied", DECLINED));
        }
        Ok(results)
    }
    /// Starts the live view's session: combined RemoteDesktop and ScreenCast where the person
    /// can be given control, else ScreenCast alone (`PortalRoute`). `restore` reuses the
    /// person's last choice silently when the desktop still has it; otherwise the dialog asks.
    pub async fn start(&mut self, choice: Choice, restore: bool) -> Result<std::os::fd::OwnedFd> {
        if self.session.is_some() {
            return Err(Fault::new("busy", "Portal session already active"));
        }
        let sources = self.offer.sources;
        let source = match choice {
            Choice::Window => SOURCE_WINDOW,
            Choice::Display => SOURCE_MONITOR,
            Choice::Any => sources & (SOURCE_WINDOW | SOURCE_MONITOR),
        };
        if source == 0 || sources & source != source {
            return Err(Fault::new(
                "not_supported",
                "This desktop's sharing dialog cannot share this kind of source",
            ));
        }
        self.picked = None;
        self.devices = 0;
        self.shown.store(0, std::sync::atomic::Ordering::Release);
        self.pointer_ready.store(false, std::sync::atomic::Ordering::Release);
        self.keyboard_ready.store(false, std::sync::atomic::Ordering::Release);
        let route = self.route();
        let owner = match route {
            PortalRoute::RemoteDesktop => "RemoteDesktop",
            PortalRoute::ScreenCastOnly(_) => "ScreenCast",
        };
        let created = self
            .request(
                owner,
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
        let result = match route {
            PortalRoute::RemoteDesktop => self.configure(&session, source, restore).await,
            PortalRoute::ScreenCastOnly(_) => {
                self.configure_screencast(&session, source, restore).await
            }
        };
        if result.is_err() {
            let _ = self.stop().await;
        }
        result
    }
    /// Asks for a remembered grant: persist until revoked, restoring the last one if asked.
    fn persist(&self, options: &mut Dict, token_path: &std::path::Path, restore: bool) -> Result<()> {
        if portal_policy(&self.offer, self.route()).persistent {
            options.insert("persist_mode".into(), OwnedValue::from(2u32));
            if restore && let Some(token) = read_token(token_path)? {
                options.insert("restore_token".into(), string(&token)?);
            }
        }
        Ok(())
    }
    /// ScreenCast keeps its own grants, apart from RemoteDesktop's, so its token is kept apart.
    fn screencast_token(&self) -> PathBuf {
        self.token_path.with_file_name("screencast-restore-token")
    }
    /// A watch-only session: the person picks the source in ScreenCast's chooser, which
    /// persists the grant itself, and the session has no input devices.
    async fn configure_screencast(
        &mut self,
        session: &OwnedObjectPath,
        source: u32,
        restore: bool,
    ) -> Result<std::os::fd::OwnedFd> {
        let token_path = self.screencast_token();
        let mut options = dict([
            ("types", OwnedValue::from(source)),
            ("multiple", OwnedValue::from(false)),
            ("cursor_mode", OwnedValue::from(1u32)),
        ]);
        self.persist(&mut options, &token_path, restore)?;
        self.request("ScreenCast", "SelectSources", Some(session), options)
            .await?;
        let result = self
            .request("ScreenCast", "Start", Some(session), HashMap::new())
            .await?;
        self.devices = 0;
        self.opened(session, source, &result, &token_path, "screencast")
            .await
    }
    async fn configure(
        &mut self,
        session: &OwnedObjectPath,
        source: u32,
        restore: bool,
    ) -> Result<std::os::fd::OwnedFd> {
        let available = self.offer.remote_desktop.map_or(0, |rd| rd.devices);
        let token_path = self.token_path.clone();
        let mut options = dict([("types", OwnedValue::from(available & 3))]);
        self.persist(&mut options, &token_path, restore)?;
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
        self.opened(session, source, &result, &token_path, "remote-desktop")
            .await
    }
    /// The started session's one stream: its node, size and kind, the restore token kept (in
    /// the permission store's `table`, where the desktop may record what was picked), and the
    /// PipeWire connection to read it from.
    async fn opened(
        &mut self,
        session: &OwnedObjectPath,
        source: u32,
        result: &Dict,
        token_path: &std::path::Path,
        table: &str,
    ) -> Result<std::os::fd::OwnedFd> {
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
        let kind: Option<u32> = props
            .get("source_type")
            .and_then(|v| v.try_clone().ok())
            .and_then(|v| v.try_into().ok());
        if !stream_matches(source, kind) {
            return Err(Fault::new(
                "not_supported",
                "The desktop shared a different kind of source than was asked for (a whole screen for a window, or a window for a screen); nothing is shown",
            ));
        }
        self.node = node;
        // The logical size maps the person's input onto the picture. KDE's window streams leave
        // it out; with no input to map (watch-only), the picture's own pixels do.
        self.size = match props.get("size") {
            Some(size) => {
                let (w, h): (i32, i32) = size
                    .try_clone()
                    .map_err(internal)?
                    .try_into()
                    .map_err(internal)?;
                if w <= 0 || h <= 0 || w > 8192 || h > 8192 {
                    return Err(Fault::new("bounds", "Invalid portal size"));
                }
                (w as u32, h as u32)
            }
            None if self.devices == 0 => (0, 0),
            None => {
                return Err(Fault::new(
                    "not_supported",
                    "Portal omitted logical size; cannot map input safely",
                ));
            }
        };
        let token: Option<String> = match result.get("restore_token") {
            Some(value) => Some(
                value
                    .try_clone()
                    .map_err(internal)?
                    .try_into()
                    .map_err(internal)?,
            ),
            None => None,
        };
        if let Some(token) = &token {
            save_token(token_path, token)?;
        } else if token_path.exists() {
            std::fs::remove_file(token_path).map_err(internal)?;
        }
        let recorded = match &token {
            Some(token) => crate::portal_choice::recorded_choice(&self.conn, table, token).await,
            None => None,
        };
        self.picked = Some(Picked::new(kind, source, recorded));
        let fd: zbus::zvariant::OwnedFd = self
            .proxy("ScreenCast")
            .await?
            .call("OpenPipeWireRemote", &(session, Dict::new()))
            .await
            .map_err(internal)?;
        Ok(fd.into())
    }
    pub async fn stop(&mut self) -> Result<()> {
        self.picked = None;
        self.devices = 0;
        if let Some(path) = self.session.take() {
            let proxy = Proxy::new(
                &self.conn,
                SERVICE,
                path.as_str(),
                "org.freedesktop.portal.Session",
            )
            .await
            .map_err(internal)?;
            // A backend stuck on its chooser closes the session itself once that is answered;
            // the portal also ends it when this process disconnects.
            match tokio::time::timeout(CLOSE_WAIT, proxy.call::<_, _, ()>("Close", &())).await {
                Ok(closed) => closed.map_err(internal)?,
                Err(_) => eprintln!("portal: the session did not close in time"),
            }
        }
        Ok(())
    }
    pub(crate) fn path(&self) -> Result<&OwnedObjectPath> {
        self.session
            .as_ref()
            .ok_or_else(|| Fault::new("target_gone", "No portal session"))
    }
    pub(crate) fn require(&self, device: u32) -> Result<()> {
        if let PortalRoute::ScreenCastOnly(reason) = self.route() {
            return Err(Fault::new("not_supported", reason));
        }
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
/// The RemoteDesktop portal, when the desktop's portal backends implement it. Without one,
/// xdg-desktop-portal doesn't export the interface and its properties can't be read.
async fn remote_desktop(conn: &Connection) -> Option<RemoteDesktopOffer> {
    let rd = Proxy::new(conn, SERVICE, PATH, "org.freedesktop.portal.RemoteDesktop")
        .await
        .ok()?;
    let devices: u32 = rd.get_property("AvailableDeviceTypes").await.ok()?;
    let version: u32 = rd.get_property("version").await.ok()?;
    Some(RemoteDesktopOffer { devices, version })
}
pub use crate::portal_token::{read_token, save_token};
