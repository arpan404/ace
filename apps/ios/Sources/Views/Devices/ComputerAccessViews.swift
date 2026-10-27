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
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            HStack(alignment: .center, spacing: AceTheme.Spacing.md) {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text("Let agents work while this Mac is locked")
                        .aceFont(AceTheme.Typography.rowTitle, relativeTo: .body)
                        .foregroundStyle(AceTheme.Colours.foreground)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(locked.label)
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(tone)
                        .contentTransition(.opacity)
                        .accessibilityIdentifier("computer.locked.state")
                }
                Spacer(minLength: AceTheme.Spacing.sm)
                Toggle("Let agents work while this Mac is locked", isOn: Binding(get: { locked.on }, set: { model.lockedUse($0 ? "install" : "remove") }))
                    .labelsHidden()
                    .disabled(busy || locked.busy || !model.canOperate)
                    .accessibilityIdentifier("computer.locked.switch")
            }
            if let note = locked.note {
                Text(note).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }
            if model.canOperate, locked.repair || locked.note != nil {
                HStack(spacing: AceTheme.Spacing.xl) {
                    if locked.repair { Button("Repair") { model.lockedUse("repair") }.accessibilityIdentifier("computer.locked.repair") }
                    Button("Check again") { model.lockedUse("recheck") }.accessibilityIdentifier("computer.locked.recheck")
                }
                .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                .tint(AceTheme.Colours.foreground)
                .buttonStyle(.borderless)
                .disabled(busy)
                .frame(minHeight: AceTheme.Dimensions.touchTarget)
            }
        }
        .padding(.vertical, AceTheme.Spacing.sm)
        .animation(AceTheme.Motion.standardCurve, value: locked)
        .sensoryFeedback(.selection, trigger: locked.on)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("computer.locked")
    }
    private var tone: Color {
        switch locked.tone {
        case "needs-you": AceTheme.StatusText.needsYou
        case "failed": AceTheme.StatusText.failed
        default: AceTheme.Colours.mutedForeground
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
                        .foregroundStyle(AceTheme.Colours.mutedForeground).insetRowBackground()
                } else {
                    Section {
                        InsetRow(systemImage: nil, title: "Browser connection",
                                 subtitle: chrome.installed ? "Installed for \(chrome.installedFor.joined(separator: ", "))." : "Agents work in tabs you share, with your sign-ins and extensions.") {
                            Button(access?.busy == "chrome.install" ? "Installing…" : chrome.installed ? "Reinstall" : "Install") { model.useMyChrome("install") }
                                .buttonStyle(.borderless)
                                .fontWeight(chrome.installed ? .regular : .semibold)
                                .disabled(busy || !model.canOperate)
                                .accessibilityIdentifier("computer.chrome.install")
                        }
                        .insetRowBackground()
                        if let path = chrome.extensionPath {
                            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                                Text("Extension").aceFont(AceTheme.Typography.rowTitle, relativeTo: .body)
                                Text("On that computer, open chrome://extensions, turn on Developer mode, choose Load unpacked and pick this folder:")
                                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                                    .fixedSize(horizontal: false, vertical: true)
                                HStack {
                                    Text(path).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                                        .lineLimit(2).truncationMode(.middle).textSelection(.enabled)
                                    Spacer(minLength: AceTheme.Spacing.sm)
                                    Button("Copy") { UIPasteboard.general.string = path }
                                        .buttonStyle(.borderless)
                                        .frame(minHeight: AceTheme.Dimensions.touchTarget)
                                }
                            }
                            .padding(.vertical, AceTheme.Spacing.sm)
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
                                if let category = RemoteSettingsCategory.all.first(where: { $0.settings.contains { $0.key == "browser.userChrome.storageReads" } }) {
                                    RemoteSettingsView(model: model, category: category)
                                }
                            } label: { InsetRow("Cookies and site storage", systemImage: nil) }
                            .insetRowBackground()
                            if model.canOperate {
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
            } else {
                ForEach(0..<2, id: \.self) { _ in
                    Capsule().fill(AceTheme.Colours.fill).frame(width: 180, height: 12)
                        .frame(minHeight: InsetStyle.rowHeight, alignment: .leading).insetRowBackground()
                }
                .accessibilityLabel("Reading Use my Chrome")
            }
        }
        .insetGroupedList()
        .animation(AceTheme.Motion.standardCurve, value: access)
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
