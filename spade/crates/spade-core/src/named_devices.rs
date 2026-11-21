//! Devices the person named with `@` in a message to a bot (ADR 0198): a machine of their fleet,
//! a phone paired with one, a simulator or emulator on one. The bot reads which, where, and
//! whether each answers, so it uses the machine it runs on, or says it would need to move.

use serde::Deserialize;

/// The most devices one message names.
pub const MOST: usize = 8;

/// One device as the person's app last saw it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct NamedDevice {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub machine: NamedMachine,
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default)]
    pub online: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct NamedMachine {
    pub id: String,
    pub name: String,
    /// The machine this Spade runs on.
    #[serde(default)]
    pub here: bool,
}

fn line(text: &str, most: usize) -> String {
    let text: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(most)
        .collect();
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn kind_words(kind: &str) -> &'static str {
    match kind {
        "simulator" => "an iOS simulator",
        "emulator" => "an Android emulator",
        "phone" => "a paired phone",
        "tablet" => "a paired tablet",
        "laptop" => "a laptop",
        "desktop" => "a desktop",
        "server" => "a server",
        _ => "a device",
    }
}

/// The context block for `devices`; `None` when there are none.
pub fn context(devices: &[NamedDevice]) -> Option<String> {
    if devices.is_empty() {
        return None;
    }
    let mut out = String::from("The person named these devices for this work:");
    let mut elsewhere = false;
    for device in devices.iter().take(MOST) {
        let machine = &device.machine;
        let is_machine = device.id == machine.id;
        let where_ = if machine.here {
            "this machine, where you run".to_owned()
        } else {
            elsewhere = true;
            format!("the machine \"{}\"", line(&machine.name, 80))
        };
        let os = device
            .os
            .as_deref()
            .map(|os| format!(", {}", line(os, 40)))
            .unwrap_or_default();
        let state = if device.online {
            "online"
        } else {
            "offline now"
        };
        let what = if is_machine {
            format!("{where_}{os}")
        } else {
            format!(
                "\"{}\", {}{os}, on {where_}",
                line(&device.name, 80),
                kind_words(&device.kind)
            )
        };
        out.push_str(&format!("\n- {what}: {state}."));
    }
    if devices.iter().any(|d| !d.online) {
        out.push_str("\nAn offline device can't be used now: say so rather than trying it.");
    }
    if elsewhere {
        out.push_str(
            "\nWhat runs on another machine isn't yours to reach from here: tell the person, \
             and offer to move to that machine (Move to…) if the work needs it.",
        );
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(id: &str, kind: &str, machine: &str, here: bool, online: bool) -> NamedDevice {
        NamedDevice {
            id: id.to_owned(),
            name: id.to_owned(),
            kind: kind.to_owned(),
            machine: NamedMachine {
                id: machine.to_owned(),
                name: machine.to_owned(),
                here,
            },
            os: None,
            online,
        }
    }

    #[test]
    fn this_machine_is_where_the_bot_runs_and_nothing_more_is_asked() {
        let read =
            context(&[device("omarchy", "server", "omarchy", true, true)]).unwrap_or_default();
        assert!(read.contains("- this machine, where you run: online."));
        assert!(!read.contains("Move to"));
    }

    #[test]
    fn a_device_elsewhere_offers_a_move_and_an_offline_one_is_said_to_be() {
        let read = context(&[device("iPhone 17", "simulator", "Studio", false, false)])
            .unwrap_or_default();
        assert!(
            read.contains(
                "\"iPhone 17\", an iOS simulator, on the machine \"Studio\": offline now."
            )
        );
        assert!(read.contains("offer to move to that machine (Move to…)"));
        assert!(read.contains("An offline device can't be used now"));
    }

    #[test]
    fn no_devices_add_nothing() {
        assert_eq!(context(&[]), None);
    }
}
