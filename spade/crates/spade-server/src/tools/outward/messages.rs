//! `send_message` (ADR 0171 decision 2): one message from the person's Messages or Mail on macOS.
//! The script is Spade's own, fixed and kept in a file of Spade's; who it goes to and what it says
//! are passed to it as arguments, so nothing the bot writes is ever read as script.

use std::path::Path;

use serde::Deserialize;
use spade_core::outward;

use super::host::{Host, HostError, Launch, Scratch};
use crate::tools::ToolOutput;

#[derive(Debug, Deserialize)]
pub(super) struct SendArgs {
    /// `messages` or `mail`.
    pub app: String,
    pub to: String,
    pub body: String,
    #[serde(default)]
    pub subject: Option<String>,
}

const MESSAGES: &str = r#"on run argv
	set theTarget to item 1 of argv
	set theText to item 2 of argv
	tell application "Messages"
		set theService to 1st account whose service type = iMessage
		send theText to participant theTarget of theService
	end tell
end run
"#;

const MAIL: &str = r#"on run argv
	set theTarget to item 1 of argv
	set theText to item 2 of argv
	set theSubject to item 3 of argv
	tell application "Mail"
		set theMessage to make new outgoing message with properties {subject:theSubject, content:theText, visible:false}
		tell theMessage to make new to recipient at end of to recipients with properties {address:theTarget}
		send theMessage
	end tell
end run
"#;

pub(super) async fn send(host: &dyn Host, scratch_root: &Path, args: SendArgs) -> ToolOutput {
    let not_sent = |why: String| ToolOutput::error(format!("Not sent: {why}."));
    if !cfg!(target_os = "macos") {
        return not_sent("Messages and Mail are sent from macOS only".to_owned());
    }
    let script = match args.app.as_str() {
        "messages" => MESSAGES,
        "mail" => MAIL,
        other => {
            return not_sent(format!(
                "{other} isn't an app Spade sends from (messages, mail)"
            ));
        }
    };
    let subject = args.subject.unwrap_or_default();
    let checked = outward::recipient(&args.to)
        .and_then(|()| outward::body(&args.body))
        .and_then(|()| match subject.chars().any(char::is_control) {
            true => Err("the subject has a line break".to_owned()),
            false => Ok(()),
        });
    if let Err(why) = checked {
        return not_sent(why);
    }
    let scratch = match Scratch::new(scratch_root) {
        Ok(scratch) => scratch,
        Err(why) => return not_sent(why),
    };
    let file = scratch.path().join("send.applescript");
    if let Err(error) = std::fs::write(&file, script) {
        return not_sent(format!("the script couldn't be written: {error}"));
    }
    let ran = host
        .run(Launch {
            program: "/usr/bin/osascript".to_owned(),
            // After the script file every word is an argument to its run handler.
            args: vec![
                file.to_string_lossy().into_owned(),
                args.to.clone(),
                args.body,
                subject,
            ],
            dir: scratch.path().to_path_buf(),
            stdin: None,
        })
        .await;
    match ran {
        Ok(ran) if ran.ok() => ToolOutput::ok(format!("Sent to {} from {}.", args.to, args.app)),
        Ok(ran) => not_sent(ran.said()),
        Err(HostError::NotStarted(why)) => not_sent(why),
        Err(HostError::Unknown(why)) => ToolOutput::maybe_ran(format!(
            "The message to {} may or may not have been sent: {why}. Check before sending it \
             again.",
            args.to
        )),
    }
}
