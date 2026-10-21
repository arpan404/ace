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
        List {
            Section {
                Button { scanning = true } label: { SettingsRow(title: "Scan the pairing code") { Image(systemName: "qrcode.viewfinder").foregroundStyle(AceTheme.Colours.subtleForeground) } }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("pairing.scan")
            } header: {
                SettingsHeader("Scan", note: "On your computer, run ace pair, or open Settings › Machines and devices and create a pairing link.")
            }
            .settingsRow()
            Section {
                TextField("https://…/pair#…", text: $pasted, axis: .vertical)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    .privacySensitive().lineLimit(1...4)
                    .aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                    .accessibilityIdentifier("pairing.link")
                PasteButton(payloadType: String.self) { values in
                    Task { @MainActor in if let value = values.first { pasted = value; accept(value) } }
                }
                Button("Continue") { accept(pasted) }
                    .aceFont(SettingsStyle.label, relativeTo: .body)
                    .disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("pairing.continue")
                if let entryError {
                    Text(entryError).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.StatusText.failed).accessibilityIdentifier("pairing.entryError")
                }
            } header: { SettingsHeader("Or paste the link") }
            .settingsRow()
        }
        .settingsList()
        .navigationTitle("Pair a computer")
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
    @State private var failure: ProblemNotice?

    var body: some View {
        List {
            Section {
                SettingsRow("Address", value: link.displayHost).accessibilityElement(children: .combine)
                SettingsRow("Access", value: link.accessSummary).accessibilityElement(children: .combine)
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                    Text("Fingerprint").aceFont(AceTheme.Typography.label, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
                    Text(link.fingerprintGroups).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.foreground).textSelection(.enabled)
                        .accessibilityIdentifier("pairing.fingerprint")
                }
            } header: {
                SettingsHeader("Computer", note: "Check that the fingerprint matches the link on your computer. ace only talks to the computer holding this key.")
            }
            .settingsRow()
            Section {
                TextField("My phone", text: $name).textInputAutocapitalization(.words).accessibilityIdentifier("pairing.name")
            } header: { SettingsHeader("This phone's name") }
            .settingsRow()
            Section {
                if let failure {
                    Text(failure.message).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.StatusText.failed).accessibilityIdentifier("pairing.error")
                }
                Button {
                    Task { await pair() }
                } label: {
                    HStack { Text(pairing ? "Pairing…" : "Pair this phone"); if pairing { Spacer(); ProgressView() } }
                }
                .aceFont(SettingsStyle.label, relativeTo: .body).fontWeight(.medium)
                .disabled(pairing || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("pairing.confirm")
            }
            .settingsRow()
        }
        .settingsList()
        .navigationTitle("Confirm computer")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(pairing)
    }
    private func pair() async {
        pairing = true
        failure = nil
        let problem = await machines.pair(link, name: String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(256)))
        pairing = false
        if let problem { failure = problem } else { onPaired() }
    }
}

extension PairingLink: Hashable, Identifiable {
    var id: String { socketURL.absoluteString + fingerprint }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}
