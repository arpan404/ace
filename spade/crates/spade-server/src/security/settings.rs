//! What the person set for security (ADR 0167 decision 10, ADR 0171 decision 5): one setting per
//! bot, `security:<bot id>`, and the machine's defaults every bot inherits, `security.machine`.
//! A bot's own value, when it has one, wins. Only the person's API writes these; no bot tool
//! changes them.

use serde::{Deserialize, Deserializer, Serialize};
use spade_core::autonomy::{Mode, lenient_mode};
use spade_core::grant::Grant;
use spade_core::permission;
use spade_sandbox::egress::NetworkPolicy;

/// Where a bot's commands run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Commands {
    /// In the bot's sandbox, where there is one.
    #[default]
    Sandboxed,
    /// Outside it, each command reviewed.
    Outside,
}

/// One bot's security settings. `None` inherits the machine's.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotSecurity {
    /// What its commands, terminal and services reach.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "own_network"
    )]
    pub network: Option<NetworkPolicy>,
    /// What its plugins' hooks and servers reach.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_network: Option<NetworkPolicy>,
    /// Where its commands run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commands: Option<Commands>,
    /// How it decides (ADR 0163, amendment 2): the auto-review or Full access.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_mode"
    )]
    pub autonomy: Option<Mode>,
    /// The person has turned Full access on for it before, so the client's confirmation was
    /// given once.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub full_access_confirmed: bool,
    /// Toolchain folders the person confirmed: read-only in the sandbox, their `bin` on `PATH`.
    #[serde(default)]
    pub toolchains: Vec<String>,
    /// Its grants, consented folders among them.
    #[serde(default)]
    pub grants: Vec<Grant>,
    /// The switches of its Permissions it sets itself (ADR 0171, amendment 7); Commands and
    /// Network are `commands` and `network` above.
    #[serde(default, skip_serializing_if = "is_default")]
    pub permissions: permission::Own,
}

fn is_default<T: Default + PartialEq>(value: &T) -> bool {
    *value == T::default()
}

/// Every earlier build stored a bot's network policy, the built-in default included; that one
/// reads as no policy of its own, so the bot follows the machine's.
fn own_network<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<NetworkPolicy>, D::Error> {
    let stored = Option::<NetworkPolicy>::deserialize(deserializer)?;
    Ok(stored.filter(|policy| *policy != NetworkPolicy::default()))
}

/// The machine's defaults, which every bot without its own inherits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineSecurity {
    #[serde(default)]
    pub commands: Commands,
    /// How a bot without its own setting decides.
    #[serde(default, deserialize_with = "machine_mode")]
    pub autonomy: Mode,
    #[serde(default)]
    pub network: NetworkPolicy,
    /// Plugins' default is any public host: the person installed them.
    #[serde(default = "NetworkPolicy::open")]
    pub plugin_network: NetworkPolicy,
    /// The Permissions every bot without its own follows, over [`permission::Held::default`].
    #[serde(default, skip_serializing_if = "is_default")]
    pub permissions: permission::Own,
    /// The apps no bot uses through Computer use, whatever its switch says.
    #[serde(default = "permission::never::default_list")]
    pub never_apps: Vec<String>,
}

impl Default for MachineSecurity {
    fn default() -> Self {
        Self {
            commands: Commands::default(),
            autonomy: Mode::default(),
            network: NetworkPolicy::default(),
            plugin_network: NetworkPolicy::open(),
            permissions: permission::Own::default(),
            never_apps: permission::never::default_list(),
        }
    }
}

impl MachineSecurity {
    /// The Permissions a bot without its own follows.
    pub fn permits(&self) -> permission::Held {
        permission::Held::default().over(&self.permissions)
    }
}

fn machine_mode<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Mode, D::Error> {
    Ok(lenient_mode(deserializer)?.unwrap_or_default())
}

/// How a bot decides, given its chain from the top bot down to it (a worker's parents first):
/// a top bot's own setting, else the machine's; a worker's own, else its parent's; and never
/// freer than any bot above it, so a bot on the auto-review can't start a worker that isn't.
pub fn autonomy<'a>(chain: impl IntoIterator<Item = &'a BotSecurity>, machine: Mode) -> Mode {
    chain
        .into_iter()
        .fold(None, |above: Option<Mode>, bot| {
            Some(match above {
                None => bot.autonomy.unwrap_or(machine),
                Some(above) => bot.autonomy.unwrap_or(above).under(above),
            })
        })
        .unwrap_or(machine)
}

/// Whether `new` reaches further than `old`: a freer mode (no network, then the listed sites,
/// then any public host), or, on the listed sites, a host added or a default put back.
pub fn widens(old: &NetworkPolicy, new: &NetworkPolicy) -> bool {
    use spade_sandbox::egress::Mode;
    let rank = |mode: Mode| match mode {
        Mode::Off => 0,
        Mode::AllowList => 1,
        Mode::Open => 2,
    };
    if rank(new.mode) != rank(old.mode) {
        return rank(new.mode) > rank(old.mode);
    }
    new.mode == Mode::AllowList
        && (new.allow.iter().any(|host| !old.allow.contains(host))
            || old.dropped.iter().any(|host| !new.dropped.contains(host)))
}

/// What holds for one bot: its own values over the machine's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Effective {
    pub commands: Commands,
    pub network: NetworkPolicy,
    pub plugin_network: NetworkPolicy,
}

pub fn effective(bot: &BotSecurity, machine: &MachineSecurity) -> Effective {
    Effective {
        commands: bot.commands.unwrap_or(machine.commands),
        network: bot
            .network
            .clone()
            .unwrap_or_else(|| machine.network.clone()),
        plugin_network: bot
            .plugin_network
            .clone()
            .unwrap_or_else(|| machine.plugin_network.clone()),
    }
}

/// The setting a bot's security is stored under.
pub fn key(bot: &str) -> String {
    format!("security:{bot}")
}

/// The setting the machine's defaults are stored under (no bot id has a dot).
pub const MACHINE: &str = "security.machine";

/// A stored value read leniently: one that doesn't parse reads as the defaults, never as an
/// error that would stop the bot's commands.
pub fn read<T: for<'de> Deserialize<'de> + Default>(stored: Option<&str>) -> T {
    stored
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use spade_core::autonomy::Mode as Autonomy;
    use spade_sandbox::egress::Mode;

    fn policy(mode: Mode) -> NetworkPolicy {
        NetworkPolicy {
            mode,
            ..NetworkPolicy::default()
        }
    }

    #[test]
    fn a_bot_inherits_the_machine_until_it_sets_its_own() {
        let machine = MachineSecurity {
            commands: Commands::Outside,
            autonomy: Autonomy::AutoReview,
            network: policy(Mode::Off),
            plugin_network: policy(Mode::AllowList),
            ..MachineSecurity::default()
        };
        let cases = [
            (
                BotSecurity::default(),
                Commands::Outside,
                Mode::Off,
                Mode::AllowList,
            ),
            (
                BotSecurity {
                    commands: Some(Commands::Sandboxed),
                    network: Some(policy(Mode::Open)),
                    plugin_network: Some(policy(Mode::Off)),
                    ..BotSecurity::default()
                },
                Commands::Sandboxed,
                Mode::Open,
                Mode::Off,
            ),
        ];
        for (bot, commands, network, plugins) in cases {
            let held = effective(&bot, &machine);
            assert_eq!(held.commands, commands);
            assert_eq!(held.network.mode, network);
            assert_eq!(held.plugin_network.mode, plugins);
        }
    }

    #[test]
    fn nothing_stored_is_the_dev_allow_list_sandboxed_with_open_plugins() {
        let held = effective(&read(None), &read(None));
        assert_eq!(held.commands, Commands::Sandboxed);
        assert_eq!(held.network, NetworkPolicy::default());
        assert_eq!(held.plugin_network, NetworkPolicy::open());
        assert_eq!(
            read::<BotSecurity>(Some("not json")),
            BotSecurity::default()
        );
    }

    fn on(mode: Option<Autonomy>) -> BotSecurity {
        BotSecurity {
            autonomy: mode,
            ..BotSecurity::default()
        }
    }

    #[test]
    fn auto_review_stays_the_default_for_new_bots() {
        let nothing: MachineSecurity = read(None);
        assert_eq!(
            autonomy([&read(None)], nothing.autonomy),
            Autonomy::AutoReview
        );
        // Settings stored by a build before Full access.
        let earlier = r#"{"commands":"outside","toolchains":[],"grants":[]}"#;
        let bot: BotSecurity = read(Some(earlier));
        let machine: MachineSecurity = read(Some(r#"{"commands":"outside"}"#));
        assert_eq!(autonomy([&bot], machine.autonomy), Autonomy::AutoReview);
        // A word this build doesn't know is the auto-review, and the rest of the bot's settings
        // still read.
        let unknown = r#"{"autonomy":"yolo","commands":"outside"}"#;
        let bot: BotSecurity = read(Some(unknown));
        assert_eq!(bot.commands, Some(Commands::Outside));
        assert_eq!(autonomy([&bot], Autonomy::FullAccess), Autonomy::AutoReview);
    }

    #[test]
    fn full_access_is_per_bot_over_the_machine_and_never_freer_than_the_bot_above() {
        use Autonomy::{AutoReview, FullAccess};
        let cases: &[(&[Option<Autonomy>], Autonomy, Autonomy)] = &[
            (&[Some(FullAccess)], AutoReview, FullAccess),
            (&[None], FullAccess, FullAccess),
            (&[Some(AutoReview)], FullAccess, AutoReview),
            // A worker follows its parent unless it has its own.
            (&[Some(FullAccess), None], AutoReview, FullAccess),
            (
                &[Some(FullAccess), Some(AutoReview)],
                AutoReview,
                AutoReview,
            ),
            // A worker of a bot on the auto-review is on it too, whatever it or the machine say.
            (
                &[Some(AutoReview), Some(FullAccess)],
                FullAccess,
                AutoReview,
            ),
            (&[None, None, Some(FullAccess)], AutoReview, AutoReview),
            (
                &[Some(FullAccess), None, Some(FullAccess)],
                AutoReview,
                FullAccess,
            ),
        ];
        for (chain, machine, expected) in cases {
            let bots: Vec<BotSecurity> = chain.iter().map(|mode| on(*mode)).collect();
            assert_eq!(
                autonomy(&bots, *machine),
                *expected,
                "{chain:?} {machine:?}"
            );
        }
    }

    #[test]
    fn an_earlier_builds_default_policy_reads_as_following_the_machine() {
        let stored = r#"{"network":{"mode":"allow_list","allow":[],"dropped":[]},"toolchains":[],"grants":[]}"#;
        assert_eq!(read::<BotSecurity>(Some(stored)).network, None);
        let own = r#"{"network":{"mode":"allow_list","allow":["example.com"],"dropped":[]}}"#;
        assert!(read::<BotSecurity>(Some(own)).network.is_some());
    }
}
