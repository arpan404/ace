//! An organization's policy (ADR 0206 §3), read from the exact body the backend signed. A
//! policy only narrows: every rule here can refuse or ask for more, none lets anything run that
//! the host wouldn't run anyway. It is read leniently and authorizes strictly: a word this build
//! doesn't know reads as the narrowest rule of its kind, never as no rule.

use serde_json::Value;

use super::Role;
use crate::effect::Effect;

/// Who may turn an effect on in a shared bot's switches, or `Off` for none of the
/// organization's shared bots.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule {
    Off,
    Admins,
    /// The bot's configurers: its maker, the members named to configure it, and admins.
    Approvers,
}

impl Rule {
    fn read(value: &Value) -> Option<Self> {
        Some(match value.as_str()? {
            "admins" => Self::Admins,
            "approvers" => Self::Approvers,
            // `off`, and a word this build doesn't know.
            _ => Self::Off,
        })
    }
}

/// Who may raise a shared bot to Full access, or let its commands run outside the sandbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Raise {
    Never,
    Admins,
    Approvers,
}

impl Raise {
    fn read(value: &Value) -> Option<Self> {
        Some(match value.as_str()? {
            "admins" => Self::Admins,
            "approvers" => Self::Approvers,
            _ => Self::Never,
        })
    }
}

/// Where a package comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Market,
    Registry,
    Git,
}

impl Source {
    pub fn parse(word: &str) -> Option<Self> {
        match word {
            "market" => Some(Self::Market),
            "registry" => Some(Self::Registry),
            "git" => Some(Self::Git),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Market => "market",
            Self::Registry => "registry",
            Self::Git => "git",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Allowed {
    source: Option<Source>,
    /// A name, or `*` for every name of the source.
    name: String,
    versions: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Blocked {
    Hash(String),
    Name(String),
}

/// One package as an install or update would put it on an org host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Package<'a> {
    pub source: Source,
    pub name: &'a str,
    pub version: &'a str,
    /// `sha256:<hex>` of its archive.
    pub hash: &'a str,
}

/// Where a shared bot's model call would go (ADR 0205).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelPlace<'a> {
    /// An endpoint, by the host its base URL names.
    Endpoint(&'a str),
    /// A model running on the host itself.
    Local,
    /// A member's coding subscription, through its CLI.
    Subscription,
}

/// The policy, as one version of it reads.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Policy {
    /// `network_without_hosts`, `publish`, `send_as_person`, `pay`, `change_access`.
    effects: [Option<Rule>; 5],
    full_access: Option<Raise>,
    commands_outside: Option<Raise>,
    members_create_bots: Option<bool>,
    sources: [Option<bool>; 3],
    allowlist: bool,
    allow: Vec<Allowed>,
    block: Vec<Blocked>,
    endpoints: Option<Vec<String>>,
    local: Option<bool>,
    targets_only: bool,
}

/// The effects a policy rules, in its words' order.
const RULED: [Effect; 5] = [
    Effect::Network,
    Effect::Publish,
    Effect::SendAsPerson,
    Effect::Pay,
    Effect::ChangeAccess,
];
const RULE_WORDS: [&str; 5] = [
    "network_without_hosts",
    "publish",
    "send_as_person",
    "pay",
    "change_access",
];

/// What a member alone (not an admin) may never turn on, whatever the policy says (§3).
const NEVER_MEMBERS: [Effect; 3] = [Effect::Pay, Effect::SendAsPerson, Effect::Publish];

impl Policy {
    /// The policy in `body`, the exact text its statement was signed over; `None` when it isn't
    /// a JSON object (such a version is never applied: the host keeps the one before).
    pub fn parse(body: &str) -> Option<Self> {
        let value: Value = serde_json::from_str(body).ok()?;
        let object = value.as_object()?;
        let mut policy = Self::default();
        if let Some(effects) = object.get("effects").and_then(Value::as_object) {
            for (at, word) in RULE_WORDS.iter().enumerate() {
                policy.effects[at] = effects
                    .get(*word)
                    .map(|v| Rule::read(v).unwrap_or(Rule::Off));
            }
        }
        policy.full_access = object
            .get("full_access")
            .map(|v| Raise::read(v).unwrap_or(Raise::Never));
        policy.commands_outside = object
            .get("commands_outside_sandbox")
            .map(|v| Raise::read(v).unwrap_or(Raise::Never));
        policy.members_create_bots = object
            .get("members_create_bots")
            // A value that isn't a boolean reads as the narrower `false`.
            .map(|v| v.as_bool().unwrap_or(false));
        if let Some(packages) = object.get("packages").and_then(Value::as_object) {
            if let Some(sources) = packages.get("sources").and_then(Value::as_object) {
                for (at, source) in [Source::Market, Source::Registry, Source::Git]
                    .into_iter()
                    .enumerate()
                {
                    policy.sources[at] = sources
                        .get(source.name())
                        .map(|v| v.as_bool().unwrap_or(false));
                }
            }
            // `open`, or no mode: anything not blocked. A mode this build doesn't know: the
            // narrower allowlist.
            policy.allowlist = packages
                .get("mode")
                .is_some_and(|mode| mode.as_str() != Some("open"));
            policy.allow = packages
                .get("allow")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(allowed).collect())
                .unwrap_or_default();
            policy.block = packages
                .get("block")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(blocked).collect())
                .unwrap_or_default();
        }
        if let Some(models) = object.get("models").and_then(Value::as_object) {
            policy.endpoints = models.get("endpoints").map(|list| {
                list.as_array()
                    .map(|hosts| {
                        hosts
                            .iter()
                            .filter_map(Value::as_str)
                            .map(|host| host.trim().to_ascii_lowercase())
                            .collect()
                    })
                    // Not a list: no endpoint at all.
                    .unwrap_or_default()
            });
            policy.local = models.get("local").map(|v| v.as_bool().unwrap_or(false));
        }
        policy.targets_only = object
            .get("audit")
            .and_then(|audit| audit.get("content"))
            .and_then(Value::as_str)
            .is_some_and(|content| content == "targets");
        Some(policy)
    }

    fn rule(&self, effect: Effect) -> Option<Rule> {
        let effect = match effect {
            // A driving step acts outside the bot: it is ruled as `network`.
            Effect::Drive => Effect::Network,
            effect => effect,
        };
        RULED
            .iter()
            .position(|ruled| *ruled == effect)
            .and_then(|at| self.effects[at])
    }

    /// Whether the policy turns `effect` off for every shared bot of the organization.
    pub fn forbids(&self, effect: Effect) -> bool {
        self.rule(effect) == Some(Rule::Off)
    }

    /// Why `member` may not turn `effect` on in a shared bot's switches, if they may not.
    /// `configurer`: they hold `configure` on that bot. Members never turn on a payment, a send
    /// in a person's name or a publish; an admin may, unless the policy turns it off or keeps it
    /// for admins and they don't configure the bot.
    pub fn switch_refusal(
        &self,
        effect: Effect,
        role: Role,
        configurer: bool,
    ) -> Option<&'static str> {
        if !configurer {
            return Some("Only those who configure this bot change its switches.");
        }
        match self.rule(effect) {
            Some(Rule::Off) => return Some(ORG_OFF),
            Some(Rule::Admins) if !role.admin() => return Some(ADMINS_ONLY),
            _ => {}
        }
        (NEVER_MEMBERS.contains(&effect) && !role.admin()).then_some(ADMINS_ONLY)
    }

    /// Whether `role`, configuring the bot, may raise a shared bot to Full access: off unless
    /// the policy allows it, and then only for the organization's owners and admins (§2.3), even
    /// where the policy names approvers.
    pub fn may_raise_full_access(&self, role: Role, configurer: bool) -> bool {
        self.full_access_allowed() && configurer && role.admin()
    }

    /// Whether the policy allows Full access for shared bots at all: a bot raised before the
    /// policy turned it off decides as on the auto-review.
    pub fn full_access_allowed(&self) -> bool {
        matches!(self.full_access, Some(Raise::Admins | Raise::Approvers))
    }

    /// Whether a shared bot's commands may run outside the sandbox at all.
    pub fn commands_outside_allowed(&self) -> bool {
        self.commands_outside != Some(Raise::Never)
    }

    /// Whether `role` may let a command run outside the sandbox (an answer, or the bot's
    /// setting). With no rule, the approvers answer as the person would.
    pub fn may_let_outside(&self, role: Role, approver: bool) -> bool {
        match self.commands_outside {
            None | Some(Raise::Approvers) => approver,
            Some(Raise::Admins) => approver && role.admin(),
            Some(Raise::Never) => false,
        }
    }

    /// Whether a member who isn't an admin may make a shared bot. With no rule they may.
    pub fn members_create_bots(&self) -> bool {
        self.members_create_bots.unwrap_or(true)
    }

    /// Why `package` may not be installed or updated onto an org host, if it may not.
    pub fn package_refusal(&self, package: Package<'_>) -> Option<String> {
        let at = match package.source {
            Source::Market => 0,
            Source::Registry => 1,
            Source::Git => 2,
        };
        // Git catalogs carry no signature: off for organizations unless the policy turns them on.
        let source_on = self.sources[at].unwrap_or(package.source != Source::Git);
        if !source_on {
            return Some(format!(
                "Your organization doesn't allow packages from {}.",
                match package.source {
                    Source::Market => "the market",
                    Source::Registry => "its registry",
                    Source::Git => "git catalogs",
                }
            ));
        }
        if let Some(why) = self.blocked(package.name, package.hash) {
            return Some(why);
        }
        let listed = self.allow.iter().any(|entry| {
            entry.source.is_none_or(|source| source == package.source)
                && (entry.name == "*" || entry.name == package.name)
                && entry
                    .versions
                    .as_ref()
                    .is_none_or(|versions| versions.iter().any(|v| v == package.version))
        });
        (self.allowlist && !listed).then(|| {
            format!(
                "{} isn't on your organization's list of allowed packages.",
                package.name
            )
        })
    }

    /// Why a shared bot running `name` at `hash` is paused, if the policy blocks it. Nothing is
    /// removed: the bot stays, paused, saying why.
    pub fn blocked(&self, name: &str, hash: &str) -> Option<String> {
        self.block
            .iter()
            .any(|blocked| match blocked {
                Blocked::Hash(blocked) => blocked == hash,
                Blocked::Name(blocked) => blocked == name,
            })
            .then(|| format!("Your organization blocked {name}."))
    }

    /// Why a shared bot's model call may not go to `place`, if it may not. Coding
    /// subscriptions never serve shared bots in M4, whatever the policy says.
    pub fn model_refusal(&self, place: ModelPlace<'_>) -> Option<&'static str> {
        match place {
            ModelPlace::Subscription => Some(
                "A shared bot never uses a member's coding subscription: give it an endpoint \
                 or a local model.",
            ),
            ModelPlace::Local => (self.local == Some(false))
                .then_some("Your organization doesn't allow local models for shared bots."),
            ModelPlace::Endpoint(host) => {
                let host = host.trim().to_ascii_lowercase();
                self.endpoints
                    .as_ref()
                    .is_some_and(|hosts| !hosts.contains(&host))
                    .then_some("Your organization doesn't allow that endpoint for shared bots.")
            }
        }
    }

    /// Whether audit entries keep only targets, without argument digests.
    pub fn targets_only(&self) -> bool {
        self.targets_only
    }
}

fn allowed(value: &Value) -> Option<Allowed> {
    let name = value.get("name")?.as_str()?.to_owned();
    // A source this build doesn't know matches no package.
    let source = match value.get("source").and_then(Value::as_str) {
        Some(word) => Some(Source::parse(word)?),
        None => None,
    };
    let versions = value.get("versions").map(|list| {
        list.as_array()
            .map(|v| {
                v.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    });
    Some(Allowed {
        source,
        name,
        versions,
    })
}

fn blocked(value: &Value) -> Option<Blocked> {
    if let Some(hash) = value.get("hash").and_then(Value::as_str) {
        return Some(Blocked::Hash(hash.to_owned()));
    }
    value
        .get("name")
        .and_then(Value::as_str)
        .map(|name| Blocked::Name(name.to_owned()))
}

pub const ADMINS_ONLY: &str = "Your organization lets only admins turn this on.";
pub const ORG_OFF: &str = "Your organization doesn't allow this for shared bots.";

/// The effect as an organization's refusal says it: "Acme doesn't allow paying."
pub fn gerund(effect: Effect) -> &'static str {
    match effect {
        Effect::Network | Effect::Drive => "reaching outside without listed hosts",
        Effect::Publish => "publishing",
        Effect::SendAsPerson => "sending in a person's name",
        Effect::Pay => "paying",
        Effect::ChangeAccess => "changing sign-ins or access",
        _ => "this",
    }
}
