//! A bot's Permissions (ADR 0171, amendment 7): switches the person turns on or off for a bot,
//! or as the default every bot without its own follows. Computer use, Browser and Simulators
//! decide driving steps outright: on, every step of that family runs with no reviewer and no
//! request; off, it is refused. Apps, Send as you and Payments refuse their effect when off and
//! leave the gate's usual route when on. Commands and Network are the existing `commands` and
//! network settings, shown here as switches. A worker is never freer than the bot above it.
//! Pure.

use serde::{Deserialize, Serialize};

pub mod never;

/// One switch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Switch {
    /// The screen and apps on this computer (`screen_*`).
    ComputerUse,
    /// ace's browser (`browser_*`).
    Browser,
    /// Simulators, emulators and devices (`sim_*`).
    Devices,
    /// Tools of the apps the person connected (connectors).
    Apps,
    /// Commands run outside the sandbox: the bot's `commands` setting.
    Commands,
    /// Hosts beyond the listed sites: the bot's network policy, open.
    Network,
    /// Sends in the person's name: still asked each time when on.
    Send,
    /// Payments: still asked each time when on.
    Pay,
}

impl Switch {
    pub const ALL: [Self; 8] = [
        Self::ComputerUse,
        Self::Browser,
        Self::Devices,
        Self::Apps,
        Self::Commands,
        Self::Network,
        Self::Send,
        Self::Pay,
    ];

    /// The word the API and the stamp use.
    pub fn key(self) -> &'static str {
        match self {
            Self::ComputerUse => "computer_use",
            Self::Browser => "browser",
            Self::Devices => "devices",
            Self::Apps => "apps",
            Self::Commands => "commands",
            Self::Network => "network",
            Self::Send => "send",
            Self::Pay => "pay",
        }
    }

    pub fn parse(word: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|switch| switch.key() == word)
    }

    /// The switch a driving tool runs under, by its family; `None` for any other tool.
    pub fn driving(tool: &str) -> Option<Self> {
        if tool.starts_with("screen_") {
            Some(Self::ComputerUse)
        } else if tool.starts_with("browser_") {
            Some(Self::Browser)
        } else if tool.starts_with("sim_") {
            Some(Self::Devices)
        } else {
            None
        }
    }

    /// Its name in the Permissions tab.
    pub fn name(self) -> &'static str {
        match self {
            Self::ComputerUse => "Computer use",
            Self::Browser => "Browser",
            Self::Devices => "Simulators and devices",
            Self::Apps => "Apps",
            Self::Commands => "Commands outside the sandbox",
            Self::Network => "Network beyond listed sites",
            Self::Send => "Send as you",
            Self::Pay => "Payments",
        }
    }

    /// Why a call that needs this switch isn't run while it is off: one line, saying where the
    /// person turns it on (the gate's refusal adds "Not run:").
    pub fn off(self) -> String {
        format!(
            "{} is off for this bot. The person can turn it on in the bot's profile, under \
             Permissions.",
            self.name()
        )
    }
}

/// The switches a bot sets for itself (`None` follows the bot above it, or the default), kept
/// with its security settings. Commands and Network live in those settings' own fields.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Own {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub computer_use: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub devices: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apps: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pay: Option<bool>,
}

impl Own {
    /// The bot's own value for `switch`; `None` for Commands and Network, kept elsewhere.
    pub fn get(&self, switch: Switch) -> Option<bool> {
        match switch {
            Switch::ComputerUse => self.computer_use,
            Switch::Browser => self.browser,
            Switch::Devices => self.devices,
            Switch::Apps => self.apps,
            Switch::Send => self.send,
            Switch::Pay => self.pay,
            Switch::Commands | Switch::Network => None,
        }
    }

    /// Sets the bot's own value (`None` follows). `false` for Commands and Network, which this
    /// doesn't hold.
    pub fn set(&mut self, switch: Switch, on: Option<bool>) -> bool {
        match self.slot_mut(switch) {
            Some(slot) => {
                *slot = on;
                true
            }
            None => false,
        }
    }

    fn slot_mut(&mut self, switch: Switch) -> Option<&mut Option<bool>> {
        Some(match switch {
            Switch::ComputerUse => &mut self.computer_use,
            Switch::Browser => &mut self.browser,
            Switch::Devices => &mut self.devices,
            Switch::Apps => &mut self.apps,
            Switch::Send => &mut self.send,
            Switch::Pay => &mut self.pay,
            Switch::Commands | Switch::Network => return None,
        })
    }
}

/// What holds for one bot: every switch, resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Held {
    pub computer_use: bool,
    pub browser: bool,
    pub devices: bool,
    pub apps: bool,
    pub send: bool,
    pub pay: bool,
}

/// The default every bot follows until the person sets one: driving is off until they turn it
/// on; connected apps, sends and payments keep the gate's usual route, which asks the person
/// before each send and payment.
impl Default for Held {
    fn default() -> Self {
        Self {
            computer_use: false,
            browser: false,
            devices: false,
            apps: true,
            send: true,
            pay: true,
        }
    }
}

impl Held {
    /// Whether `switch` is on; Commands and Network aren't held here and read as off.
    pub fn on(&self, switch: Switch) -> bool {
        match switch {
            Switch::ComputerUse => self.computer_use,
            Switch::Browser => self.browser,
            Switch::Devices => self.devices,
            Switch::Apps => self.apps,
            Switch::Send => self.send,
            Switch::Pay => self.pay,
            Switch::Commands | Switch::Network => false,
        }
    }

    fn with(mut self, switch: Switch, on: bool) -> Self {
        match switch {
            Switch::ComputerUse => self.computer_use = on,
            Switch::Browser => self.browser = on,
            Switch::Devices => self.devices = on,
            Switch::Apps => self.apps = on,
            Switch::Send => self.send = on,
            Switch::Pay => self.pay = on,
            Switch::Commands | Switch::Network => {}
        }
        self
    }

    /// The machine's defaults with `own` set over them (how Settings › Spade stores them).
    pub fn over(self, own: &Own) -> Self {
        Switch::ALL
            .into_iter()
            .fold(self, |held, switch| match own.get(switch) {
                Some(on) => held.with(switch, on),
                None => held,
            })
    }
}

/// What holds for a bot, given its chain from the top bot down to it (a worker's parents
/// first): a top bot's own value, else the machine's default; a worker's own, else its
/// parent's; and a worker never has a switch on that a bot above it has off.
pub fn held<'a>(chain: impl IntoIterator<Item = &'a Own>, machine: Held) -> Held {
    chain
        .into_iter()
        .fold(None, |above: Option<Held>, own| {
            Some(match above {
                None => machine.over(own),
                Some(above) => Switch::ALL.into_iter().fold(above, |held, switch| {
                    let on = own.get(switch).unwrap_or(true) && above.on(switch);
                    held.with(switch, on)
                }),
            })
        })
        .unwrap_or(machine)
}

#[cfg(test)]
mod tests;
