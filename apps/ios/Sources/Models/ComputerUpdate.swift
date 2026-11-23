import Foundation

/// What the connected computer's update row shows, from the daemon's report. Pure, so the words
/// and the order of the steps are tested directly.
enum ComputerUpdateStep: Equatable {
    /// The computer's ace doesn't answer update requests: its version, and where updates run.
    case versionOnly
    case blocked(String)
    case check
    case checking
    case upToDate
    case available(String)
    case waiting
    case downloading(Int?)
    case restarting
    case failed(String)
}

enum ComputerUpdate {
    /// `checked`: the person's check just finished and found nothing.
    static func step(_ info: MachineUpdateInfo, machine: String, checked: Bool, asking: Bool) -> ComputerUpdateStep {
        guard info.known else { return .versionOnly }
        switch info.phase {
        case "checking": return .checking
        case "waiting": return .waiting
        case "downloading": return .downloading(info.percent.map { Int($0.rounded()) })
        case "restarting": return .restarting
        default: break
        }
        if asking { return .checking }
        if let blocked = info.blocked, blocked != "unknown" || info.available == nil {
            switch blocked {
            case "app-closed": return .blocked("Open ace on \(machine) to update it")
            case "release-page": return .blocked("\(machine) updates from the release page, on the computer")
            case "source": return .blocked("\(machine) runs ace from source")
            default: break
            }
        }
        if info.phase == "failed" { return .failed(info.error ?? "The update didn’t finish. Try again.") }
        if let version = info.available { return .available(version) }
        return checked ? .upToDate : .check
    }

    /// The version the phone already knows for a computer, from its update report, the desktop app's
    /// report or its provider status, in that order; nil when none has said yet.
    static func knownVersion(update: MachineUpdateInfo?, app: MachineAppUpdateInfo?, daemon: String?) -> String? {
        if let update, update.known, !update.version.isEmpty { return update.version }
        if let app, app.known, !app.version.isEmpty, app.version != "Unknown" { return app.version }
        if let daemon, !daemon.isEmpty { return daemon }
        return nil
    }

    /// The computer row's title and line when its ace can't be updated from here (or hasn't
    /// said what it runs yet).
    static func readOnly(machine: String, version: String?) -> (title: String, line: String) {
        guard let version else { return (machine, "Waiting for \(machine)…") }
        return ("\(machine): ace \(version)", "Updates run on \(machine)")
    }

    /// The question before an update starts, and what "now" costs.
    static func question(machine: String) -> String { "Update \(machine) now or when its agents are idle?" }

    static func nowDetail(_ working: [String]) -> String {
        switch working.count {
        case 0: return "No agents are working."
        case 1: return "This stops 1 working agent, which continues after the restart: \(working[0])"
        default:
            let shown = working.prefix(5).joined(separator: ", ")
            let more = working.count > 5 ? " and \(working.count - 5) more" : ""
            return "This stops \(working.count) working agents, which continue after the restart: \(shown)\(more)"
        }
    }
}
