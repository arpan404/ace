//! A bot's Permissions on the server (ADR 0171, amendment 7): reading what holds for a bot and
//! the machine, and changing a switch or the never-use list. Computer use, Browser, Simulators,
//! Apps, Send as you and Payments are kept in each bot's and the machine's security settings;
//! Commands and Network are the existing `commands` and network settings, so one switch never
//! disagrees with the setting it shows. Turning anything on, and letting bots use an app the
//! never-use list held back, is the person's alone: it needs their stamp (`attest`), as Full
//! access does. Turning a switch off, or adding to the list, never does.

use serde_json::{Map, Value, json};
use spade_core::permission::{self, Held, Switch, never};
use spade_sandbox::egress::{Mode as NetMode, NetworkPolicy};

use super::settings::{BotSecurity, Commands, MachineSecurity, effective};
use super::{Security, SecurityError};

/// What a raise refused for want of the person's say tells the caller.
pub const PERSON_ONLY: &str =
    "Only the person can turn this on: do it in ace, on this computer or a paired device.";

/// What a raise on a shared bot by a member who may not make it tells them.
pub const NOT_YOURS: &str = "Only the organization's owners and admins can turn this on.";

/// The value a stamp for turning `switch` to `on` signs (`null`: follow the default).
pub fn stamped(switch: Switch, on: Option<bool>) -> String {
    let on = on.map_or("null", |on| if on { "true" } else { "false" });
    format!("permission:{}:{on}", switch.key())
}

/// The value a stamp for setting the never-use list to `list` signs: its entries joined by a
/// control character no entry may hold (`never::clean`).
pub fn stamped_list(list: &[String]) -> String {
    format!("never_apps:{}", list.join("\u{1f}"))
}

/// Who asks for a change, and whether they may raise it.
pub enum Asker<'a> {
    /// Through ace's daemon, with the person's stamp when it sent one.
    Person(Option<&'a str>),
    /// A member configuring a shared bot (ADR 0206 §2.3): `admin` for an owner or admin, and
    /// whether the organization lets its commands run outside the sandbox.
    Member { admin: bool, commands_outside: bool },
}

impl Security {
    /// What holds for `bot`: its own switches over the bot above it, the machine's at the top,
    /// never freer than a bot above it.
    pub fn permits(&self, bot: &str) -> Held {
        let mut chain = self.above(bot);
        chain.push(self.bot(bot));
        let owns: Vec<permission::Own> = chain.iter().map(|each| each.permissions).collect();
        permission::held(&owns, self.machine().permits())
    }

    /// The apps no bot uses through Computer use.
    pub fn never_apps(&self) -> Vec<String> {
        self.machine().never_apps
    }

    /// Whether `switch` is on for `bot`: Commands and Network as its settings hold them.
    fn on_for(&self, bot: &str, switch: Switch) -> bool {
        holds(&self.above(bot), &self.bot(bot), &self.machine(), switch)
    }

    /// A bot's Permissions as its profile shows them: each switch, whether it sets its own, and
    /// the machine's never-use list.
    pub fn permissions_view(&self, bot: &str) -> Value {
        let settings = self.bot(bot);
        let mut on = Map::new();
        let mut own = Map::new();
        for switch in Switch::ALL {
            on.insert(switch.key().to_owned(), json!(self.on_for(bot, switch)));
            let set = match switch {
                Switch::Commands => settings.commands.is_some(),
                Switch::Network => settings.network.is_some(),
                _ => settings.permissions.get(switch).is_some(),
            };
            own.insert(switch.key().to_owned(), json!(set));
        }
        json!({ "on": on, "own": own, "never_apps": self.never_apps() })
    }

    /// The machine's Permissions, as Settings › Spade shows them.
    pub fn machine_permissions_view(&self) -> Value {
        let machine = self.machine();
        let permits = machine.permits();
        let mut on = Map::new();
        for switch in Switch::ALL {
            let value = match switch {
                Switch::Commands => machine.commands == Commands::Outside,
                Switch::Network => machine.network.mode == NetMode::Open,
                _ => permits.on(switch),
            };
            on.insert(switch.key().to_owned(), json!(value));
        }
        json!({ "on": on, "never_apps": machine.never_apps })
    }

    /// Sets one of `bot`'s switches; `None` follows the bot above it, or the machine's. A change
    /// that turns it on for the bot is `asker`'s to make only as [`Asker`] says, decided under the
    /// same lock as the write, against the bots above it and the machine as they are then.
    pub fn set_permission(
        &self,
        bot: &str,
        switch: Switch,
        on: Option<bool>,
        asker: Asker<'_>,
    ) -> Result<BotSecurity, SecurityError> {
        self.change(bot, |current| {
            let above = self.above(bot);
            let machine = self.machine();
            let mut next = current.clone();
            apply(&mut next, switch, on, &machine);
            let raises =
                !holds(&above, current, &machine, switch) && holds(&above, &next, &machine, switch);
            if raises {
                let (may, refused) = match asker {
                    Asker::Person(stamp) => (
                        self.person_says(stamp, bot, &stamped(switch, on)),
                        PERSON_ONLY,
                    ),
                    Asker::Member {
                        admin,
                        commands_outside,
                    } => (
                        admin && (switch != Switch::Commands || commands_outside),
                        NOT_YOURS,
                    ),
                };
                if !may {
                    return Err(SecurityError::PersonOnly(refused));
                }
            }
            *current = next;
            Ok(())
        })
    }

    /// Sets one of the machine's switches, which every bot without its own follows; turning one
    /// on needs the person's stamp.
    pub fn set_machine_permission(
        &self,
        switch: Switch,
        on: bool,
        stamp: Option<&str>,
    ) -> Result<MachineSecurity, SecurityError> {
        if on && !self.person_says(stamp, "machine", &stamped(switch, Some(true))) {
            return Err(SecurityError::PersonOnly(PERSON_ONLY));
        }
        self.change_machine(|machine| match switch {
            Switch::Commands => {
                machine.commands = if on {
                    Commands::Outside
                } else {
                    Commands::Sandboxed
                };
            }
            Switch::Network => machine.network = opened(&machine.network, on),
            _ => {
                machine.permissions.set(switch, Some(on));
            }
        })
    }

    /// Sets the never-use list. A list that drops an entry lets bots use that app, so it needs
    /// the person's stamp; one that only adds doesn't.
    pub fn set_never_apps(
        &self,
        given: &[String],
        stamp: Option<&str>,
    ) -> Result<MachineSecurity, SecurityError> {
        let list = never::clean(given).map_err(|why| SecurityError::Invalid(why.to_owned()))?;
        let drops = !never::dropped(&self.never_apps(), &list).is_empty();
        if drops && !self.person_says(stamp, "machine", &stamped_list(&list)) {
            return Err(SecurityError::PersonOnly(PERSON_ONLY));
        }
        self.change_machine(|machine| machine.never_apps = list)
    }
}

/// Whether `switch` is on for a bot with settings `bot` under the bots `above` it (the top one
/// first) and `machine`.
fn holds(
    above: &[BotSecurity],
    bot: &BotSecurity,
    machine: &MachineSecurity,
    switch: Switch,
) -> bool {
    match switch {
        Switch::Commands => effective(bot, machine).commands == Commands::Outside,
        Switch::Network => effective(bot, machine).network.mode == NetMode::Open,
        _ => {
            let owns: Vec<permission::Own> = above
                .iter()
                .chain(std::iter::once(bot))
                .map(|each| each.permissions)
                .collect();
            permission::held(&owns, machine.permits()).on(switch)
        }
    }
}

/// `switch` set to `on` in a bot's settings: Commands and Network in their own fields.
fn apply(current: &mut BotSecurity, switch: Switch, on: Option<bool>, machine: &MachineSecurity) {
    match switch {
        Switch::Commands => {
            current.commands = on.map(|on| {
                if on {
                    Commands::Outside
                } else {
                    Commands::Sandboxed
                }
            });
        }
        Switch::Network => {
            current.network = on.map(|on| {
                let base = current.network.as_ref().unwrap_or(&machine.network);
                opened(base, on)
            });
        }
        _ => {
            current.permissions.set(switch, on);
        }
    }
}

/// `policy` open to any public host (`on`), or back to its listed sites; a policy with no
/// network at all stays so when turned off.
fn opened(policy: &NetworkPolicy, on: bool) -> NetworkPolicy {
    let mode = match (on, policy.mode) {
        (true, _) => NetMode::Open,
        (false, NetMode::Off) => NetMode::Off,
        (false, _) => NetMode::AllowList,
    };
    NetworkPolicy {
        mode,
        ..policy.clone()
    }
}
