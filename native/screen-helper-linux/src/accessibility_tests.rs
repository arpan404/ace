//! Exercise real D-Bus reads and actions through Accessibility's public API.
use super::*;
use std::sync::{Arc, Mutex};
use tokio::net::UnixStream;

#[derive(Default)]
struct Control { name: String, gone: bool, presses: usize }
struct Accessible(Arc<Mutex<Control>>);
#[zbus::interface(name = "org.a11y.atspi.Accessible")]
impl Accessible {
    #[zbus(property)]
    fn name(&self) -> zbus::fdo::Result<String> {
        let control = self.0.lock().unwrap();
        if control.gone { Err(zbus::fdo::Error::UnknownObject("removed".into())) }
        else { Ok(control.name.clone()) }
    }
    #[zbus(property)]
    fn description(&self) -> String { String::new() }
    #[zbus(property)]
    fn child_count(&self) -> i32 { 0 }
    fn get_role_name(&self) -> &str { "button" }
    fn get_state(&self) -> StateSet { StateSet::new(State::Enabled | State::Sensitive | State::Showing) }
    fn get_interfaces(&self) -> Vec<&str> { vec!["org.a11y.atspi.Action"] }
}
struct Action(Arc<Mutex<Control>>);
#[zbus::interface(name = "org.a11y.atspi.Action")]
impl Action {
    #[zbus(property)]
    fn n_actions(&self) -> i32 { 1 }
    fn get_name(&self, _index: i32) -> &str { "click" }
    fn do_action(&self, _index: i32) -> bool { self.0.lock().unwrap().presses += 1; true }
}
struct PrivateBus(std::process::Child);
impl Drop for PrivateBus {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct Fixture { ui: Accessibility, server: Connection, control: Arc<Mutex<Control>>, _bus: Option<PrivateBus> }
impl Fixture {
    async fn new() -> Self {
        let control = Arc::new(Mutex::new(Control { name: "original".into(), ..Default::default() }));
        let (server, client) = UnixStream::pair().unwrap();
        let server = zbus::connection::Builder::unix_stream(server)
            .server(zbus::Guid::try_from("1234567890abcdef1234567890abcdef").unwrap()).unwrap()
            .p2p().serve_at("/control", Accessible(control.clone())).unwrap()
            .serve_at("/control", Action(control.clone())).unwrap();
        let client = zbus::connection::Builder::unix_stream(client).p2p();
        let (server, client) = futures_util::try_join!(server.build(), client.build()).unwrap();
        let mut ui = Accessibility::from_connection(client).await.unwrap();
        ui.scope = Some(("org.ace.Fixture".into(), OwnedObjectPath::try_from("/control").unwrap()));
        Self { ui, server, control, _bus: None }
    }
    #[cfg(target_os = "linux")]
    async fn on_bus() -> Self {
        use std::io::{BufRead, BufReader};
        let mut bus = PrivateBus(std::process::Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--print-address=1"])
            .stdout(std::process::Stdio::piped()).spawn().unwrap());
        let mut address = String::new();
        BufReader::new(bus.0.stdout.take().unwrap()).read_line(&mut address).unwrap();
        let control = Arc::new(Mutex::new(Control { name: "original".into(), ..Default::default() }));
        let server = zbus::connection::Builder::address(address.trim()).unwrap()
            .serve_at("/control", Accessible(control.clone())).unwrap()
            .serve_at("/control", Action(control.clone())).unwrap().build().await.unwrap();
        let client = zbus::connection::Builder::address(address.trim()).unwrap().build().await.unwrap();
        let mut ui = Accessibility::from_connection(client).await.unwrap();
        ui.scope = Some((server.unique_name().unwrap().to_string(), OwnedObjectPath::try_from("/control").unwrap()));
        Self { ui, server, control, _bus: Some(bus) }
    }
    async fn reference(&mut self) -> String {
        self.ui.tree(0, 1).await.unwrap()["tree"]["ref"].as_str().unwrap().into()
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn cache_removal_retires_saved_refs_before_successful_reads_of_a_reused_bus_path() {
    // A real private bus requires the Cache match rule; a peer-to-peer connection
    // alone would not catch a missing subscription.
    let mut fixture = Fixture::on_bus().await;
    let old = fixture.reference().await;
    let removed = (fixture.server.unique_name().unwrap().to_string(), OwnedObjectPath::try_from("/control").unwrap());
    fixture.server.emit_signal(None::<&str>, "/org/a11y/atspi/cache", "org.a11y.atspi.Cache", "RemoveAccessible", &(removed,)).await.unwrap();
    fixture.control.lock().unwrap().name = "replacement".into();
    let found = fixture.ui.find(&Query { name: Some("replacement".into()), ..Default::default() }, 1).await.unwrap();
    let replacement = found["nodes"][0]["ref"].as_str().unwrap();
    assert_ne!(old, replacement);
    assert_eq!(fixture.ui.act(&old, "press", None).await.unwrap_err().code, "target_gone");
    assert_eq!(fixture.control.lock().unwrap().presses, 0);
    fixture.ui.act(replacement, "press", None).await.unwrap();
    assert_eq!(fixture.control.lock().unwrap().presses, 1);
}

#[tokio::test]
async fn a_failed_fresh_read_retires_the_ref_before_a_provider_reuses_its_path() {
    let mut fixture = Fixture::new().await;
    let old = fixture.reference().await;
    assert_eq!(fixture.reference().await, old);
    fixture.control.lock().unwrap().gone = true;
    assert_eq!(fixture.ui.tree(0, 1).await.unwrap_err().code, "target_gone");
    { let mut control = fixture.control.lock().unwrap(); control.gone = false; control.name = "replacement".into(); }
    let replacement = fixture.reference().await;
    assert_ne!(old, replacement);
    assert_eq!(fixture.ui.act(&old, "press", None).await.unwrap_err().code, "target_gone");
    assert_eq!(fixture.control.lock().unwrap().presses, 0);
    fixture.ui.act(&replacement, "press", None).await.unwrap();
    assert_eq!(fixture.control.lock().unwrap().presses, 1);
}

#[tokio::test]
async fn removal_signals_retire_refs_even_if_no_read_observes_the_missing_object() {
    let mut fixture = Fixture::new().await;
    let old = fixture.reference().await;
    fixture.server.emit_signal(None::<&str>, "/control", "org.a11y.atspi.Event.Object", "ChildrenChanged",
        &("remove", 0i32, 0i32, zbus::zvariant::OwnedValue::from(0i32), std::collections::HashMap::<String, zbus::zvariant::OwnedValue>::new())).await.unwrap();
    fixture.control.lock().unwrap().name = "replacement".into();
    // The action's provider fence consumes the queued removal before resolving its ref.
    assert_eq!(fixture.ui.act(&old, "press", None).await.unwrap_err().code, "target_gone");
    assert_eq!(fixture.control.lock().unwrap().presses, 0);
    let replacement = fixture.reference().await;
    assert_ne!(old, replacement);
    fixture.ui.act(&replacement, "press", None).await.unwrap();
    assert_eq!(fixture.control.lock().unwrap().presses, 1);
}

#[tokio::test]
async fn a_clipped_final_match_keeps_find_truncated_when_no_more_children_remain() {
    let mut fixture = Fixture::new().await;
    fixture.control.lock().unwrap().name = "x".repeat(257);
    let query = Query { role: Some("button".into()), ..Default::default() };
    let found = fixture.ui.find(&query, 1).await.unwrap();
    assert_eq!(found["nodes"].as_array().unwrap().len(), 1);
    assert_eq!(found["nodes"][0]["name"].as_str().unwrap(), "x".repeat(256));
    assert_eq!(found["truncated"], true);
    fixture.control.lock().unwrap().name = "ordinary".into();
    assert_eq!(fixture.ui.find(&query, 1).await.unwrap()["truncated"], false);
}
