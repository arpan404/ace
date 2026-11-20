import SwiftUI

/// Continue on / Open on a machine that doesn't take projects from the sending one (ADR 0101):
/// why, in one sentence, and the next step. When the phone is paired with that machine too and
/// may grant Projects there, Allow projects widens the link's own device through that machine's
/// runtime and goes on to the options. Otherwise the words say where it's done.
struct AllowProjectsStep: View {
    /// The sending machine's runtime, which walks the sheet.
    let model: ClientModel
    let step: TransferSheetState.Allow
    @Environment(\.otherMachines) private var others
    @State private var offer: AllowProjectsOffer?
    @State private var refused: String?
    @State private var allowing = false

    /// That machine's runtime, while the phone reaches it.
    private var there: ClientModel? {
        guard let client = others.client(step.machine.hostId), client.connection == "ready" else { return nil }
        return client
    }

    var body: some View {
        Section {
            Text(words)
                .foregroundStyle(AceTheme.Colours.foreground)
                .accessibilityIdentifier("transfer.allow.words")
        } header: { InsetHeader(step.heading) }
        .insetRowBackground()
        .task(id: there?.connection) { await read() }
        if let next {
            Section {
                Button { act(next) } label: {
                    Text(next == .allow ? step.action : "Continue").fontWeight(AceDesign.Typeface.strong).frame(maxWidth: .infinity)
                        .foregroundStyle(AceTheme.Colours.onAccent)
                }
                .buttonStyle(.borderedProminent).tint(AceTheme.Colours.accent)
                .controlSize(.large).buttonBorderShape(.capsule)
                .disabled(allowing || !model.canOperate)
                .accessibilityIdentifier("transfer.allow")
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        }
    }

    private enum Next { case allow, proceed }
    /// Allow projects while that machine says this phone may; Continue once it takes them.
    private var next: Next? {
        guard refused == nil, there != nil else { return nil }
        switch offer?.offer {
        case "allow": return .allow
        case "held": return .proceed
        default: return nil
        }
    }

    private var words: String {
        if let refused { return refused }
        if there == nil { return step.unreached }
        return offer?.words ?? "Checking \(step.machine.name)…"
    }

    private func read() async {
        guard let there else { offer = nil; return }
        offer = await there.allowProjectsOffer(deviceId: step.machine.deviceId, sender: step.sender, machine: step.machine.name)
    }

    private func act(_ next: Next) {
        if next == .proceed { model.transfer(["kind": "allowed"]); return }
        guard let there else { return }
        allowing = true
        Task {
            let answer = await there.setLinkProjects(deviceId: step.machine.deviceId, allowed: true, machine: step.machine.name)
            allowing = false
            if answer.ok { model.transfer(["kind": "allowed"]) } else { refused = answer.message ?? "\(step.machine.name) didn't change the link." }
        }
    }
}
