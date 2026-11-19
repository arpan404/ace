import SwiftUI

/// What a list shows in place of rows, or that it shows its rows.
enum ForgeListState: Equatable {
    case reading, unreachable, attention, failed(String), empty, rows

    /// Before anything is read, a machine that's out wins over a read that failed: the read most
    /// likely failed because the machine went, and asking GitHub again can't help until it's back.
    /// A failure while the machine is still connecting keeps the skeleton, since the list reads
    /// again once it's ready; only a ready machine's failure is shown as GitHub's. Rows already
    /// read stay shown whatever the connection.
    static func of(loaded: Bool, failure: String?, empty: Bool, connection: String) -> ForgeListState {
        guard !loaded else { return empty ? .empty : .rows }
        if let out = out(connection) { return out }
        if let failure, connection == "ready" { return .failed(failure) }
        return .reading
    }

    /// A machine that's out: offline or reconnecting comes back by itself or on Retry; a refused
    /// connection (`fatal`: a revoked pairing, a machine code) needs the person. Nil otherwise.
    static func out(_ connection: String) -> ForgeListState? {
        switch connection {
        case "fatal": .attention
        case "offline", "reconnecting": .unreachable
        default: nil
        }
    }
}

/// How a review page gets its machine back: the connection, and where the person re-pairs it or
/// looks at it when retrying can't help.
struct ForgeMachineRecovery {
    let client: ClientModel
    var pair: (() -> Void)? = nil
    var openMachines: (() -> Void)? = nil
}

/// The machine is out, said once for every review list and the page before them. Offline:
/// what loads once it's back, and Retry, which asks the connection to reconnect and reads again.
/// Refused: the machine code when that's what it waits on, as the inbox asks for it; otherwise
/// the connection's own problem with Pair again and Machines, since retrying can't help.
struct ForgeMachineOut: View {
    let machine: ForgeMachineRecovery
    let noun: String
    let reload: () async -> Void
    private var client: ClientModel { machine.client }

    var body: some View {
        Group {
            if ForgeListState.out(client.connection) == .attention {
                attention
            } else {
                EmptyState(icon: .wifiSlash, title: "Can't reach this machine", line: "\(noun) load once it's connected.") {
                    Button("Retry") {
                        client.retry()
                        Task { await reload() }
                    }
                    .accessibilityIdentifier("forge.list.retry")
                }
                .accessibilityIdentifier("forge.list.unreachable")
            }
        }
    }

    @ViewBuilder private var attention: some View {
        if let ask = client.machineCodeAsk {
            EmptyState(icon: .lock, title: "Enter the machine code", line: ask.message(lockedUntil: client.machineCodeLockedUntil)) {
                if ask.canEnter {
                    Button("Enter code") { client.machineCodeDeferred = false }
                        .accessibilityIdentifier("forge.list.code")
                }
            }
            .accessibilityIdentifier("forge.list.attention")
        } else {
            EmptyState(icon: .wifiSlash, title: "Connection needs attention",
                       line: client.problem?.message ?? "This iPhone's pairing with the machine no longer works.") {
                VStack(spacing: AceDesign.Space.related) {
                    if let pair = machine.pair {
                        Button("Pair again", action: pair).accessibilityIdentifier("forge.list.pair")
                    }
                    if let openMachines = machine.openMachines {
                        Button("Open Machines", action: openMachines)
                            .buttonStyle(.secondaryAction)
                            .accessibilityIdentifier("forge.list.machines")
                    }
                }
            }
            .accessibilityIdentifier("forge.list.attention")
        }
    }
}
