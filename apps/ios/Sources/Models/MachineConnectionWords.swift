import Foundation

/// How one machine's connection reads, from the runtime state the inbox and the threads use
/// (`ClientModel.shownConnection`, which hides a reconnect for a few seconds). One rule for the Machines page and the Account sheet, so the two
/// never disagree: a ready runtime is Connected whatever an older status line says.
enum MachineConnectionWords {
    static func of(state: String?, status: StatusDisplay?, needsPairing: Bool = false, off: Bool = false) -> (display: StatusDisplay, trying: Bool) {
        if needsPairing { return (StatusDisplay(label: "Pair again", token: "failed"), false) }
        if off { return (StatusDisplay(label: "Off on this iPhone", token: "neutral"), false) }
        switch state {
        case "ready": return (StatusDisplay(label: "Connected", token: "done"), false)
        case "connecting", "starting": return (StatusDisplay(label: "Connecting…", token: "neutral"), true)
        case "reconnecting": return (status ?? StatusDisplay(label: "Reconnecting", token: "neutral"), true)
        default: return (status ?? StatusDisplay(label: "Offline", token: "neutral"), false)
        }
    }
}
