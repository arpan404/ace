import SwiftUI
import UIKit

/// Locked computer use on the Computer use screen: the Mac's actual state in a word (loud only
/// when it needs the person or failed), a switch that installs or removes the component, Repair
/// when what's installed drifted, and Check again while macOS waits for approval.
struct LockedUseRow: View {
    let model: ClientModel
    let locked: ComputerAccessModel.Locked
    let busy: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            HStack(alignment: .center, spacing: AceDesign.Space.row) {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text("Let agents work while this Mac is locked")
                        .font(AceDesign.Typeface.body)
                        .foregroundStyle(AceDesign.Ink.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(locked.label)
                        .font(AceDesign.Typeface.meta)
                        .foregroundStyle(tone)
                        .contentTransition(.opacity)
                        .accessibilityIdentifier("computer.locked.state")
                }
                Spacer(minLength: AceDesign.Space.related)
                Toggle("Let agents work while this Mac is locked", isOn: Binding(get: { locked.on }, set: { model.lockedUse($0 ? "install" : "remove") }))
                    .labelsHidden()
                    .disabled(locked.unavailable || busy || locked.busy || !model.canOperate || !model.mayAdminister)
                    .accessibilityIdentifier("computer.locked.switch")
            }
            if let note = locked.note {
                Text(note).font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }
            if !model.mayAdminister {
                // A read pairing sees the Mac's state; only its owner turns locked use on or off.
                OwnerOnlyNote().transition(.opacity)
            } else if model.canOperate, !locked.unavailable, locked.repair || locked.note != nil {
                HStack(spacing: AceDesign.Space.group) {
                    if locked.repair { Button("Repair") { model.lockedUse("repair") }.accessibilityIdentifier("computer.locked.repair") }
                    Button("Check again") { model.lockedUse("recheck") }.accessibilityIdentifier("computer.locked.recheck")
                }
                .font(AceDesign.Typeface.body)
                .tint(AceDesign.Ink.accent)
                .buttonStyle(.borderless)
                .disabled(busy)
                .frame(minHeight: AceDesign.Size.tap)
            }
        }
        .padding(.vertical, AceDesign.Space.related)
        .animation(.default, value: locked)
        .sensoryFeedback(.selection, trigger: locked.on)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("computer.locked")
    }
    private var tone: Color {
        switch locked.tone {
        case "needs-you": AceTheme.StatusText.needsYou
        case "failed": AceTheme.StatusText.failed
        default: AceDesign.Ink.muted
        }
    }
}

/// Use my Chrome (ADR 0084): agents work in tabs of the person's own Chrome, with its sign-ins
/// and extensions. Install the browser connection on the machine, load the extension there,
/// see which browsers are connected, stop agents, or revoke every browser.
struct UseMyChromeView: View {
    let model: ClientModel
    @State private var revoking = false
    private var access: ComputerAccessModel.State? { model.computerAccess.state }
    private var chrome: ComputerAccessModel.Chrome? { access?.chrome }
    private var busy: Bool { access?.busy != nil }

    var body: some View {
        List {
            if let chrome {
                if !chrome.supported {
                    Text("Use my Chrome works on macOS and Linux for now.")
                        .foregroundStyle(AceDesign.Ink.muted).insetRowBackground()
                } else {
                    Section {
                        InsetRow(systemImage: nil, title: "Browser connection",
                                 subtitle: chrome.installed ? "Installed for \(chrome.installedFor.joined(separator: ", "))." : "Agents work in tabs you share, with your sign-ins and extensions.") {
                            Button(access?.busy == "chrome.install" ? "Installing…" : chrome.installed ? "Reinstall" : "Install") { model.useMyChrome("install") }
                                .buttonStyle(.borderless)
                                .fontWeight(chrome.installed ? .regular : .semibold)
                                .disabled(busy || !model.canOperate || !model.mayAdminister)
                                .accessibilityIdentifier("computer.chrome.install")
                        }
                        .insetRowBackground()
                        if let path = chrome.extensionPath {
                            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                                Text("Extension").font(AceDesign.Typeface.body)
                                Text("On that computer, open chrome://extensions, turn on Developer mode, choose Load unpacked and pick this folder:")
                                    .font(AceDesign.Typeface.meta)
                                    .foregroundStyle(AceDesign.Ink.muted)
                                    .fixedSize(horizontal: false, vertical: true)
                                HStack {
                                    Text(path).font(AceDesign.Typeface.code)
                                        .lineLimit(2).truncationMode(.middle).textSelection(.enabled)
                                    Spacer(minLength: AceDesign.Space.related)
                                    Button("Copy") { UIPasteboard.general.string = path }
                                        .buttonStyle(.borderless)
                                        .frame(minHeight: AceDesign.Size.tap)
                                }
                            }
                            .padding(.vertical, AceDesign.Space.related)
                            .insetRowBackground()
                            .accessibilityIdentifier("computer.chrome.extension")
                        }
                    } header: { InsetHeader("Use my Chrome") }
                    if chrome.installed {
                        Section {
                            if chrome.connections.isEmpty {
                                InsetRow("No browser connected", systemImage: nil).insetRowBackground()
                            }
                            ForEach(chrome.connections) { connection in
                                InsetRow(icon: .globe, title: connection.title, subtitle: connection.summary) { EmptyView() }
                                    .insetRowBackground()
                            }
                        } header: { InsetHeader("Connected browsers") }
                        Section {
                            NavigationLink {
                                // The Browser and computer page holds the Chrome storage switch.
                                RemoteSettingsView(model: model, category: .browser)
                            } label: { InsetRow("Cookies and site storage", systemImage: nil) }
                            .insetRowBackground()
                            if model.canOperate, model.mayAdminister {
                                Button("Stop agents in my Chrome") { model.useMyChrome("stop") }
                                    .disabled(busy || !chrome.controlled)
                                    .insetRowBackground()
                                    .accessibilityIdentifier("computer.chrome.stop")
                                Button("Revoke every browser…", role: .destructive) { revoking = true }
                                    .disabled(busy)
                                    .insetRowBackground()
                                    .accessibilityIdentifier("computer.chrome.revoke")
                            }
                        } footer: { Text("Stop releases every tab. Revoke disconnects every browser until you reinstall.") }
                    }
                }
                if let error = access?.error {
                    ServiceProblem(message: error).listRowBackground(Color.clear)
                }
            } else if !model.mayAdminister {
                // Use my Chrome is the owner's; it isn't read for anyone else, so nothing spins.
                OwnerOnlyNote().insetRowBackground().transition(.opacity)
            } else {
                ForEach(0..<2, id: \.self) { _ in
                    SkeletonBar(width: 180, height: 12)
                        .frame(minHeight: InsetStyle.rowHeight, alignment: .leading).insetRowBackground()
                }
                .accessibilityLabel("Reading Use my Chrome")
            }
        }
        .insetGroupedList()
        .animation(.default, value: access)
        .navigationTitle("Use my Chrome").navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Revoke every browser?", isPresented: $revoking, titleVisibility: .visible) {
            Button("Revoke", role: .destructive) { model.useMyChrome("revoke") }
        } message: {
            Text("Every connected browser disconnects until you install the browser connection again.")
        }
        .onAppear { model.followComputerAccess() }
        .onDisappear { model.unfollowComputerAccess() }
    }
}

/// Said where a change is the machine owner's alone (an admin pairing).
struct OwnerOnlyNote: View {
    var body: some View {
        Text("Only the machine's owner can change this.")
            .font(AceDesign.Typeface.meta)
            .foregroundStyle(AceDesign.Ink.muted)
            .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap, alignment: .leading)
            .accessibilityIdentifier("computer.ownerOnly")
    }
}
