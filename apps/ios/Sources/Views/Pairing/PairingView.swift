import SwiftUI
import UIKit

/// Scan or paste the link from `ace pair`, then confirm before anything is sent.
struct PairingView: View {
    let machines: MachinesModel
    var onPaired: () -> Void = {}
    @State private var pasted = ""
    @State private var link: PairingLink?
    @State private var entryError: String?
    @State private var scanning = false
    @State private var scanAttempt = 0

    var body: some View {
        QuietPage {
            Group {
                QuietGroup {
                    Button { scanning = true } label: { Text("Scan pairing QR code") }
                        .accessibilityIdentifier("pairing.scan")
                } footer: {
                    Text("On your computer, run `ace pair` or open Settings › Machines and devices and create a pairing link.")
                }
                QuietGroup {
                    TextField("https://…/pair#…", text: $pasted, axis: .vertical)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .privacySensitive().lineLimit(1...4)
                        .font(AceDesign.Typeface.code)
                        .accessibilityIdentifier("pairing.link")
                    Button("Continue") { accept(pasted) }
                        .disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("pairing.continue")
                } header: { InsetHeader("Or paste the link") }
                if let entryError {
                    QuietGroup { Text(entryError).foregroundStyle(AceTheme.StatusText.failed).accessibilityIdentifier("pairing.entryError") }
                }
            }

        }

        .navigationTitle("Pair a machine")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $link) { link in
            ConfirmPairingView(link: link, machines: machines) {
                pasted = ""
                self.link = nil
                onPaired()
            }
        }
        .sheet(isPresented: $scanning) { scanner }
    }
    private var scanner: some View {
        NavigationStack {
            QRScannerView(found: { value in scanning = false; accept(value) },
                          unavailable: { message in scanning = false; entryError = message })
                .id(scanAttempt)
                .ignoresSafeArea()
                .navigationTitle("Scan pairing code").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { scanning = false } } }
        }
    }
    private func accept(_ text: String) {
        do throws(PairingLinkError) {
            link = try PairingLink.parse(text)
            entryError = nil
        } catch {
            entryError = error.message
            scanAttempt += 1
        }
    }
}

/// The host chose the grant; the person confirms the computer and names this phone.
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
        QuietPage {
            Group {
                QuietGroup {
                    LabeledContent("Address", value: link.displayHost)
                    LabeledContent("Access", value: link.accessSummary)
                    VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                        Text("Fingerprint").font(AceDesign.Typeface.body).foregroundStyle(AceDesign.Ink.muted)
                        Text(link.fingerprintGroups).font(AceDesign.Typeface.code)
                            .foregroundStyle(AceDesign.Ink.primary).textSelection(.enabled)
                            .accessibilityIdentifier("pairing.fingerprint")
                    }
                } header: { InsetHeader("Computer") } footer: {
                    Text("Check that the fingerprint matches the link on your computer. ace only talks to the computer holding this key.")
                }
                QuietGroup {
                    TextField("My phone", text: $name).textInputAutocapitalization(.words).accessibilityIdentifier("pairing.name")
                } header: { InsetHeader("This phone's name") }
                if let failure {
                    QuietGroup { Text(failure.message).foregroundStyle(AceTheme.StatusText.failed).accessibilityIdentifier("pairing.error") }
                }
                QuietGroup {
                    Button {
                        submission = Task { await pair() }
                    } label: {
                        HStack { Text(pairing ? "Pairing…" : failure == nil ? "Pair this phone" : "Retry"); if pairing { Spacer(); WorkingMark(label: "Pairing") } }
                    }
                    .disabled(pairing || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .buttonStyle(.textAction(.prominent))
                    .accessibilityIdentifier("pairing.confirm")
                }
            }

        }

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

extension PairingLink: Hashable, Identifiable {
    var id: String { socketURL.absoluteString + fingerprint }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}
