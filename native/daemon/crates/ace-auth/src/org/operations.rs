// SPDX-License-Identifier: Apache-2.0
//! What each socket message is for the access policy (`org-access/socket-operations.ts`): the
//! operation a type asks for, the resource it names, and the channel a hello opens. A type
//! listed nowhere is unclassified, and `decide` refuses it on an org host.

use ace_json::Value;

use super::decide::{Operation, Resource, filtered, host, tree, unplaced};
use super::trees::TreeRef;

pub fn socket_operation(message: &Value) -> Option<Operation> {
    let name = message.get("type").and_then(Value::as_str)?;
    if let Some(operation) = exact_operation(name) {
        return Some(operation);
    }
    if let Some(operation) = prefix_operation(name) {
        return Some(operation);
    }
    if name == "fleet.request" {
        let op = message
            .get("operation")
            .and_then(|operation| operation.get("op"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        return Some(fleet_operation(op));
    }
    if name == "command" {
        let payload = message
            .get("command")
            .and_then(|command| command.get("payload"))
            .and_then(|payload| payload.get("type"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        return Some(match payload {
            "thread.create" => Operation::TreeCreate,
            "thread.interrupt" => Operation::TreeStop,
            _ => Operation::TreeWrite,
        });
    }
    None
}

fn exact_operation(name: &str) -> Option<Operation> {
    use Operation::*;
    Some(match name {
        "hello"
        | "ping"
        | "unsubscribe"
        | "presence.update"
        | "account.grant.refresh"
        | "account.standing"
        | "device.standing"
        | "catalog.unsubscribe"
        | "notification.unregister"
        | "browser.unsubscribe"
        | "skills.unsubscribe" => Session,
        "account.owner.release" | "account.owner.enroll" | "account.owner.enroll.confirm" => {
            HostAdmin
        }
        "host.identity"
        | "diagnostics.health"
        | "appUpdate.request"
        | "machineUpdate.request"
        | "icons.read"
        | "icons.resolve"
        | "avatars.resolve"
        | "permissions.capabilities"
        | "onboarding.query"
        | "onboarding.dismiss"
        | "search.status" => HostMeta,
        "diagnostics.request"
        | "admission.request"
        | "storage.request"
        | "projects.request"
        | "devices.request"
        | "devices.ack"
        | "outside.request"
        | "user_browser.settings"
        | "machine.code.clear"
        | "machine.code.set"
        | "machine.code.status"
        | "provider.logout"
        | "providers.request"
        | "marketplace.request"
        | "pluginRequest"
        | "suitRequest"
        | "suitWatch"
        | "suitReport" => HostAdmin,
        "terminal.request" | "terminal.credit" => HostShell,
        "subscribe"
        | "threads.page"
        | "items.page"
        | "items.window"
        | "entities.page"
        | "turns.page"
        | "turn.steps"
        | "item.raw"
        | "output.read"
        | "interaction.read"
        | "thread.catchUp"
        | "thread.readState"
        | "thread.search"
        | "search.query"
        | "activity.reads"
        | "activity.markRead"
        | "context.request"
        | "preview.request"
        | "queue.get"
        | "command.status"
        | "commands.list"
        | "commands.resolve"
        | "catalog.list"
        | "notification.feed"
        | "notification.ack"
        | "notification.register"
        | "notification.snooze"
        | "notification.config"
        | "notification.preferences"
        | "automation.list"
        | "automation.inbox"
        | "browser.subscribe"
        | "browser.tabs.list"
        | "browser.downloads.list"
        | "browser.download.read"
        | "browser.browsing.watch" => TreeRead,
        "cli.request"
        | "pi.control"
        | "workspace.request"
        | "source-control.request"
        | "repositories.request"
        | "verify.request"
        | "skills.request"
        | "prompts.request" => TreeWrite,
        "worktree.creation.request"
        | "history.list"
        | "history.import"
        | "history.continue"
        | "history.release"
        | "automation.put"
        | "automation.remove"
        | "automation.run"
        | "automation.retry"
        | "automation.setEnabled"
        | "automation.webhook" => TreeCreate,
        "machines.request" | "machine.call" | "machine.cancel" | "spade.machines"
        | "spade.remote" => FleetLink,
        "machine.transfer" | "transfers.request" => Transfer,
        "pair.redeem" => Pairing,
        "screen.request"
        | "screen.ack"
        | "computer.using.watch"
        | "media.connect"
        | "spade.computer.drive"
        | "spade.computer.get" => Computer,
        _ => return None,
    })
}

fn prefix_operation(name: &str) -> Option<Operation> {
    use Operation::*;
    const PREFIXES: [(&str, Operation); 16] = [
        ("browser.backend.", HostAdmin),
        ("user_browser.", HostAdmin),
        ("browser.", TreeWrite),
        ("spade.", Spade),
        ("settings.", HostAdmin),
        ("accounts.", HostAdmin),
        ("provider.accounts.", HostAdmin),
        ("provider.login.", HostAdmin),
        ("provider.install.", HostAdmin),
        ("cursor.auth.", HostAdmin),
        ("lockedUse.", HostAdmin),
        ("registry.", HostAdmin),
        ("mcp.", HostAdmin),
        ("models.", HostMeta),
        ("usage.", HostMeta),
        ("files.", HostShell),
    ];
    PREFIXES
        .iter()
        .find(|(prefix, _)| name.starts_with(prefix))
        .map(|(_, operation)| *operation)
}

/// `fleet.request` carries pairing and device care as well as fleet links.
fn fleet_operation(op: &str) -> Operation {
    match op {
        "pairing" | "pairings" | "cancelPairing" => Operation::Pairing,
        "devices" | "revoke" | "revokeOthers" | "scope" => Operation::HostAdmin,
        "remoteStatus" => Operation::HostMeta,
        _ => Operation::FleetLink,
    }
}

/// The resource a message names. A tree operation names the thread it carries (top level, in a
/// subscription's scope, a terminal's operation or a command's payload); one that names none
/// can't be placed.
pub fn socket_resource(message: &Value, operation: Operation) -> Resource {
    if !operation.as_str().starts_with("tree.") {
        return host();
    }
    if operation == Operation::TreeRead
        && message.get("type").and_then(Value::as_str) == Some("notification.feed")
    {
        return filtered();
    }
    let nested = |key: &str| {
        message
            .get(key)
            .and_then(|value| value.get("threadId"))
            .and_then(Value::as_str)
    };
    let payload = message
        .get("command")
        .and_then(|command| command.get("payload"));
    let thread = message
        .get("threadId")
        .and_then(Value::as_str)
        .filter(|thread| !thread.is_empty())
        .or_else(|| nested("scope"))
        .or_else(|| nested("operation"))
        .or_else(|| {
            payload
                .and_then(|payload| payload.get("threadId"))
                .and_then(Value::as_str)
        });
    if let Some(thread) = thread.filter(|thread| !thread.is_empty()) {
        return tree(TreeRef::Thread(thread.to_owned()));
    }
    let payload_id = |key: &str| {
        payload
            .and_then(|payload| payload.get(key))
            .and_then(Value::as_str)
    };
    if let Some(interaction) = payload_id("interactionId") {
        return tree(TreeRef::Interaction(interaction.to_owned()));
    }
    if let Some(task) = payload_id("taskId") {
        return tree(TreeRef::Task(task.to_owned()));
    }
    unplaced()
}

/// What opening a dedicated channel is (hello `channel`).
pub fn channel_operation(channel: Option<&str>) -> Option<Operation> {
    match channel {
        None => Some(Operation::Session),
        Some("files") => Some(Operation::HostShell),
        Some("devices" | "provider_auth") => Some(Operation::HostAdmin),
        Some("browser") => Some(Operation::TreeWrite),
        Some("screen" | "media") => Some(Operation::Computer),
        Some("machine" | "tunnel") => Some(Operation::FleetLink),
        Some(_) => None,
    }
}
