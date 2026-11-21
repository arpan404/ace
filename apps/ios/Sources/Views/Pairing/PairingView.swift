import SwiftUI
import UIKit

/// Scan or paste the link from Pair a device on the computer, then confirm before anything is
/// sent (`ConfirmPairingView`).
struct PairingView: View {
    let machines: MachinesModel
    var onPaired: () -> Void = {}
    @State private var pasted = ""
    @State private var link: PairingLink?
    @State private var entryError: String?
    @State private var scanning = false
    @FocusState private var editing: Bool

    var body: some View {
        List {
            Section {
                Button { scanning = true } label: {
                    Label("Scan QR code", ace: .qrCode).frame(maxWidth: .infinity)
                }
                .pairingPrimaryButton()
                .accessibilityIdentifier("pairing.scan")
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            } footer: {
                Text("On your computer, open Settings › Fleet › Pair a device, or run `ace pair` in a terminal.")
                    .padding(.top, AceDesign.Space.related)
            }
            Section {
                HStack(spacing: AceDesign.Space.related) {
                    TextField("Pairing link", text: $pasted, axis: .vertical)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .privacySensitive().lineLimit(1...4).focused($editing)
                        .font(AceDesign.Typeface.code)
                        .submitLabel(.go).onSubmit(submit)
                        .accessibilityIdentifier("pairing.link")
                    if pasted.isEmpty {
                        PasteButton(payloadType: String.self) { strings in
                            Task { @MainActor in if let first = strings.first { paste(first) } }
                        }
                        .labelStyle(.titleOnly).buttonBorderShape(.capsule).controlSize(.small)
                        .tint(AceDesign.Ink.primary)
                        .accessibilityIdentifier("pairing.paste")
                    }
                }
                if let entryError {
                    Label(entryError, ace: .warningCircle)
                        .font(AceDesign.Typeface.meta).foregroundStyle(AceTheme.StatusText.failed)
                        .accessibilityIdentifier("pairing.entryError")
                }
            } header: {
                InsetHeader("Or paste the link")
            }
            .insetRowBackground()
            Section {
                Button("Continue", action: submit)
                    .frame(maxWidth: .infinity)
                    .pairingSecondaryButton()
                    .disabled(trimmed.isEmpty)
                    .accessibilityIdentifier("pairing.continue")
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
        }
        .insetGroupedList()
        .navigationTitle("Pair a machine")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $link) { link in
            ConfirmPairingView(link: link, machines: machines) {
                pasted = ""
                self.link = nil
                onPaired()
            }
        }
        .fullScreenCover(isPresented: $scanning) {
            QRScannerView(check: Self.problem(with:),
                          found: { value in scanning = false; accept(value) },
                          paste: pasteFromScanner,
                          close: { scanning = false })
        }
    }

    private var trimmed: String { pasted.trimmingCharacters(in: .whitespacesAndNewlines) }
    private func submit() { if !trimmed.isEmpty { accept(pasted) } }

    /// Why a scanned or pasted code can't pair, or nil when it can.
    static func problem(with text: String) -> String? {
        do throws(PairingLinkError) {
            _ = try PairingLink.parse(text)
            return nil
        } catch {
            return error.message
        }
    }

    private func accept(_ text: String) {
        do throws(PairingLinkError) {
            link = try PairingLink.parse(text)
            entryError = nil
        } catch {
            entryError = error.message
        }
    }

    /// A pasted link goes straight on when it's a good one; anything else stays in the field.
    private func paste(_ text: String) {
        pasted = text
        accept(text)
    }

    /// Paste from the scanner: the copied link, or the field to paste into by hand.
    private func pasteFromScanner() {
        scanning = false
        if UIPasteboard.general.hasStrings, let text = UIPasteboard.general.string {
            paste(text)
        } else {
            editing = true
        }
    }
}

extension PairingLink: Hashable, Identifiable {
    var id: String { socketURL.absoluteString + fingerprint }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}
