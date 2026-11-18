import SwiftUI
import UIKit

/// The host chose the grant; the person checks the computer's fingerprint, names this phone and
/// pairs. Nothing is sent before Pair this phone.
struct ConfirmPairingView: View {
    let link: PairingLink
    let machines: MachinesModel
    let onPaired: () -> Void
    @State private var name = UIDevice.current.name
    @State private var pairing = false
    @State private var submission: Task<Void, Never>?
    @State private var failure: ProblemNotice?
    /// The machine just paired, while its first run shows (`FirstRunView`).
    @State private var settingUp: String?

    var body: some View {
        List {
            Section {
                LabeledContent("Address", value: link.displayHost)
                LabeledContent("Access", value: link.accessSummary)
                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                    Text("Fingerprint").foregroundStyle(AceDesign.Ink.primary)
                    Text(link.fingerprintGroups).font(AceDesign.Typeface.code)
                        .foregroundStyle(AceDesign.Ink.muted).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("pairing.fingerprint")
                }
                .padding(.vertical, AceDesign.Space.tight)
            } header: {
                InsetHeader("Computer")
            } footer: {
                Text("Check that this fingerprint matches the one on your computer. ace only talks to the computer that holds it.")
            }
            .insetRowBackground()
            Section {
                TextField("My phone", text: $name).textInputAutocapitalization(.words)
                    .accessibilityIdentifier("pairing.name")
                if let failure {
                    Label(failure.message, systemImage: "exclamationmark.circle")
                        .font(AceDesign.Typeface.meta).foregroundStyle(AceTheme.StatusText.failed)
                        .accessibilityIdentifier("pairing.error")
                }
            } header: {
                InsetHeader("This phone's name")
            }
            .insetRowBackground()
            Section {
                Button { submission = Task { await pair() } } label: {
                    HStack(spacing: AceDesign.Space.related) {
                        if pairing { ProgressView().tint(AceTheme.Colours.onAccent) }
                        Text(pairing ? "Pairing…" : failure == nil ? "Pair this phone" : "Try again")
                    }
                    .frame(maxWidth: .infinity)
                }
                .pairingPrimaryButton()
                .disabled(pairing || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("pairing.confirm")
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
        }
        .insetGroupedList()
        .overlay(alignment: .bottomTrailing) { PairingAttemptsProbe(count: machines.pairAttempts) }
        .navigationTitle("Confirm computer")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(isPresented: Binding(get: { settingUp != nil }, set: { if !$0 { settingUp = nil } })) {
            if let host = settingUp, let client = machines.inbox.client(host) {
                FirstRunView(model: client, afterPairing: true, done: onPaired)
            }
        }
        .onDisappear { submission?.cancel(); submission = nil }
    }

    private func pair() async {
        pairing = true
        failure = nil
        let problem = await machines.pair(link, name: pairingDeviceName(name))
        pairing = false
        guard !Task.isCancelled else { return }
        if let problem { failure = problem; return }
        // The new machine's agents next, when none can run a thread yet.
        if let host = machines.lastPaired, machines.inbox.client(host) != nil { settingUp = host } else { onPaired() }
    }
}
