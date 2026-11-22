import SwiftUI

/// How to recover a machine that didn't take this phone's proof of the person's standing, by the
/// route the proof went over. Pairing again removes the machine and its unsent work, so it is
/// offered only where it can help: a paired machine's direct socket, proven with its paired key.
/// Over the account relay the proof is the account's, so the way out is signing in again.
enum StandingRecovery: Equatable {
    case none, pairAgain, signIn
    static func of(standing: PairedStanding?, needsPairing: Bool, isAccountMachine: Bool, onRelay: Bool) -> StandingRecovery {
        guard !needsPairing, !isAccountMachine, standing == .missing else { return .none }
        return onRelay ? .signIn : .pairAgain
    }
}

/// A paired machine that didn't take this phone's proof of the person's standing (ADR 0190 §7):
/// paired before the phone named a key, or from an ordinary link. It says what that stops and
/// offers Pair again, on the machine's page.
struct StandingMissingRow: View {
    let name: String
    let pairAgain: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            Text("Installing bots and plugins on \(name) from this iPhone needs it paired again, with a code you make in ace on your computer.")
                .aceFont(AceDesign.TextRole.rowTitle)
                .foregroundStyle(AceTheme.StatusText.needsYou).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("machine.standing.missing")
            Button("Pair again", action: pairAgain)
                .buttonStyle(.secondaryAction).accessibilityIdentifier("machine.standing.pairAgain")
        }
        .padding(.vertical, AceDesign.Space.tight)
    }
}

extension View {
    /// Asks before pairing `hostId` again: this phone removes the machine and its unsent work,
    /// then opens the scanner. Pairing the same machine twice isn't allowed, so it goes first.
    func pairAgainDialog(_ hostId: Binding<String?>, machines: MachinesModel?, inbox: MachineInbox) -> some View {
        modifier(PairAgainDialog(hostId: hostId, machines: machines, inbox: inbox))
    }
}

private struct PairAgainDialog: ViewModifier {
    @Binding var hostId: String?
    let machines: MachinesModel?
    let inbox: MachineInbox
    @Environment(\.settingsPush) private var push
    @State private var notice: ProblemNotice?

    private var name: String {
        guard let hostId else { return "" }
        return machines?.entry(hostId)?.displayName ?? inbox.name(hostId)
    }

    func body(content: Content) -> some View {
        content
            .confirmationDialog("Pair \(name) again?", isPresented: Binding(get: { hostId != nil }, set: { if !$0 { hostId = nil } }),
                                titleVisibility: .visible, presenting: hostId) { asked in
                Button("Remove and pair again", role: .destructive) { Task { await pairAgain(asked) } }
                    .accessibilityIdentifier("machine.standing.pairAgain.confirm")
            } message: { _ in
                Text("This iPhone removes \(name) and its unsent work for it, then scans a new code. Make the code in ace on your computer, in Machines and devices.")
            }
            .alert("Couldn't remove the machine", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
                Button("OK") { notice = nil }
            } message: { Text(notice?.message ?? "") }
    }

    private func pairAgain(_ hostId: String) async {
        guard let machines else { return }
        await machines.remove(hostId)
        if machines.entry(hostId) == nil { push(.pair) } else { notice = machines.problem ?? .unknown }
    }
}
