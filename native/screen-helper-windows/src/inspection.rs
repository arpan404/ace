//! Permission inspection stays available when desktop initialization is unsafe.
use crate::{
    codec::Request,
    errors::{Error, Result},
};
use serde_json::{json, Value};

pub enum Startup<T> {
    Desktop(T),
    Inspection(Inspection),
}
impl<T> Startup<T> {
    pub fn open(access: Result<()>, initialize: impl FnOnce() -> Result<T>) -> Result<Self> {
        match access {
            Ok(()) => initialize().map(Self::Desktop),
            Err(reason) => Ok(Self::Inspection(Inspection { reason })),
        }
    }
}

pub struct Inspection {
    reason: Error,
}
impl Inspection {
    pub fn command(&self, request: &Request) -> Result<Value> {
        match request.op.as_str() {
            "hello" => {
                let mut hello = capabilities();
                hello["inspectionOnly"] = json!(true);
                hello["capture"] = json!({"windows":false,"displays":false,"changeDriven":false});
                hello["input"] =
                    json!({"pointer":false,"keyboard":false,"scroll":false,"text":false});
                hello["uiTree"] = json!(false);
                hello["semanticActions"] = json!([]);
                hello["permissions"] = json!({"screen":"denied","input":"denied"});
                Ok(hello)
            }
            "permissions" | "permissions.request" => Ok(permissions(Err(self.reason.clone()))),
            _ => Err(self.reason.clone().phase("rejected-before-dispatch")),
        }
    }
}

pub fn capabilities() -> Value {
    json!({"version":2,"platform":"windows",
        "capture":{"windows":true,"displays":true,"changeDriven":true},
        "input":{"pointer":true,"keyboard":true,"scroll":true,"text":true},
        "uiTree":true,"semanticActions":["press","focus","setValue","scroll","expand","select"],
        "codecs":["jpeg"],"permissions":{"screen":"n/a","input":"granted"}})
}

pub fn permissions(access: Result<()>) -> Value {
    let desktop = access.is_ok();
    let message = match access {
        Ok(()) => "The helper can access the interactive input desktop.".to_string(),
        Err(reason) => reason.message,
    };
    json!({"platform":"win32", "screen":if desktop {"n/a"} else {"denied"}, "input":if desktop {"granted"} else {"denied"}, "screenRecording":desktop,"accessibility":desktop,
    "requirements":[
      {"kind":"interactiveDesktop", "state":if desktop {"ready"} else {"blocked"}, "title":"Interactive Windows desktop", "message":message},
      {"kind":"targetIntegrity", "state":"unknown", "title":"Target integrity level", "message":"Windows UIPI prevents a non-elevated helper from controlling elevated apps. Run the target app without administrator privileges. This is checked when interacting with the target."},
      {"kind":"desktopCapture", "state":"unknown", "title":"Windows desktop capture", "message":"Capture availability is checked when a view starts. If Windows requests screen capture access, allow it on this machine, then retry."}
    ]})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::Code;
    fn request(op: &str) -> Request {
        Request::decode(
            json!({"version":2,"id":"test","op":op})
                .to_string()
                .as_bytes(),
        )
        .unwrap()
    }
    #[test]
    fn blocked_startup_answers_inspection_without_initializing_desktop_services() {
        for (session, state, desktop, reason) in [
            (0, Some(0), true, "signed-in session"),
            (1, Some(4), true, "reconnect"),
            (1, None, true, "reconnect"),
            (1, Some(0), false, "Unlock"),
        ] {
            let host = Startup::<()>::open(
                crate::session::desktop_access(session, state, desktop),
                || {
                    Err(Error::new(
                        Code::Internal,
                        "Desktop initialization must not run",
                    ))
                },
            )
            .unwrap();
            let Startup::Inspection(host) = host else {
                panic!("Expected inspection mode")
            };
            let hello = host.command(&request("hello")).unwrap();
            assert_eq!(hello["inspectionOnly"], true);
            assert_eq!(hello["uiTree"], false);
            for op in ["permissions", "permissions.request"] {
                let reply = host.command(&request(op)).unwrap();
                assert_eq!(reply["requirements"][0]["kind"], "interactiveDesktop");
                assert_eq!(reply["requirements"][0]["state"], "blocked");
                assert!(reply["requirements"][0]["message"]
                    .as_str()
                    .unwrap()
                    .contains(reason));
            }
            for op in ["targets", "start", "stop", "ui.tree", "ui.act", "key.press"] {
                let error = host.command(&request(op)).unwrap_err();
                assert!(error.message.contains(reason));
                assert_eq!(error.phase, Some("rejected-before-dispatch"));
            }
        }
    }
    #[test]
    fn active_desktop_initializes_the_runtime_and_preserves_startup_failures() {
        assert!(matches!(
            Startup::open(crate::session::desktop_access(1, Some(0), true), || Ok(42)).unwrap(),
            Startup::Desktop(42)
        ));
        let result = Startup::<()>::open(Ok(()), || {
            Err(Error::new(
                Code::PermissionDenied,
                "UI Automation: access denied",
            ))
        });
        assert_eq!(
            result.err().unwrap().message,
            "UI Automation: access denied"
        );
        assert_eq!(permissions(Ok(()))["requirements"][0]["state"], "ready");
    }
}
