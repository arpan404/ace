import SwiftUI

/// Where a subagent ace delegated to another machine opens (ADR 0078; the web's
/// `DelegatedElsewhereView`): on that machine when this phone reaches it, else words naming the
/// machine and why it can't open now. Nothing falls back to another machine.
enum DelegatedElsewhere: Equatable {
    case open(machineId: String)
    case away(String)

    /// `connection` is the machine's runtime state on this phone; nil when it isn't paired.
    static func reach(host: String, name: String, connection: String?) -> DelegatedElsewhere {
        switch connection {
        case nil: .away("This phone isn't paired with \(name), where this subagent runs.")
        case "ready": .open(machineId: host)
        case "connecting", "starting", "reconnecting": .away("Connecting to \(name)…")
        default: .away("\(name) isn't connected. Open this subagent again once it's back.")
        }
    }
}

extension EnvironmentValues {
    /// Opens a subagent ace delegated to another machine: its host id, its thread id and the
    /// machine's name as its parent knows it. Returns why it can't open now, nil once it opened.
    /// The inbox sets it where it pushes thread pages.
    @Entry var openElsewhere: ((_ host: String, _ threadId: String, _ name: String) -> String?)? = nil
}
