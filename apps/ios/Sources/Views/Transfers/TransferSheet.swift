import SwiftUI

/// Continue on… and Open on… (ADR 0101), as a native sheet: which machine, then whether to bring
/// uncommitted changes and ignored files and where it goes, then the transfer's one line until
/// it's done. The bridge walks the steps; this draws them in inset groups.
struct TransferSheet: View {
    let model: ClientModel
    let sheet: TransferSheetState
    @Environment(\.otherMachines) private var others
    @Environment(\.colorScheme) private var scheme
    @State private var changes = true
    /// Follows this machine's "Bring ignored files" until the person flips it here.
    @State private var ignored: Bool?
    @State private var parent: String?

    var body: some View {
        NavigationStack {
            List { content }
                .insetGroupedList()
                .navigationTitle(sheet.title).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if case .options = sheet.step {
                        ToolbarItem(placement: .topBarLeading) {
                            Button { model.transfer(["kind": "back"]) } label: { Image(systemName: "chevron.backward") }
                                .accessibilityLabel("Machines").accessibilityIdentifier("transfer.back")
                        }
                    }
                    ToolbarItem(placement: .cancellationAction) {
                        Button { model.transfer(["kind": "close"]) } label: { Image(systemName: "xmark") }
                            .accessibilityLabel("Close").accessibilityIdentifier("transfer.close")
                    }
                }
        }
        .tint(AceTheme.Colours.foreground)
        .toggleStyle(.systemSwitch)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        .accessibilityIdentifier("transfer.sheet")
    }

    @ViewBuilder private var content: some View {
        switch sheet.step {
        case .checking(let words):
            Section {
                HStack(spacing: AceTheme.Spacing.md) {
                    ProgressView()
                    Text(words).foregroundStyle(AceTheme.Colours.mutedForeground)
                }
            }
            .insetRowBackground()
        case .machines(let machines, let empty):
            Section {
                ForEach(machines) { machine in machineRow(machine) }
                if let empty { Text(empty).foregroundStyle(AceTheme.Colours.mutedForeground) }
            } header: { InsetHeader("\(verb) “\(sheet.what)” on") }
            .insetRowBackground()
        case .options(let machine, let action, let ignoredByDefault):
            options(machine, action: action, ignoredByDefault: ignoredByDefault)
        case .status(_, let action, let line):
            Section {
                TransferLineView(model: model, line: line) { model.transfer(["kind": "close"]) }
            } header: { InsetHeader(action) }
            .insetRowBackground()
        }
    }
    private var verb: String { sheet.kind == "thread" ? "Continue" : "Open" }

    private func machineRow(_ machine: TransferMachineRow) -> some View {
        Button { model.transfer(["kind": "choose", "hostId": machine.hostId]) } label: {
            InsetRow(machine.name, systemImage: "desktopcomputer", value: machine.reason)
                .opacity(machine.reason == nil ? 1 : AceTheme.Opacity.disabled(scheme))
        }
        .buttonStyle(.plain)
        .disabled(machine.reason != nil)
        .accessibilityIdentifier("transfer.machine.\(machine.hostId)")
    }

    @ViewBuilder private func options(_ machine: TransferSheetState.Machine, action: String, ignoredByDefault: Bool) -> some View {
        let bringIgnored = Binding(get: { ignored ?? ignoredByDefault }, set: { ignored = $0 })
        Section {
            Toggle("Bring uncommitted changes", isOn: $changes).accessibilityIdentifier("transfer.changes")
            Toggle("Bring ignored files", isOn: bringIgnored).accessibilityIdentifier("transfer.ignored")
            folderRow(machine)
        } header: { InsetHeader("On \(machine.name)") }
        .insetRowBackground()
        Section {
            Button {
                var send: [String: Any] = ["kind": "send", "includeChanges": changes, "includeIgnored": ignored ?? ignoredByDefault]
                if let parent { send["parent"] = parent }
                model.transfer(send)
            } label: {
                Text(action).fontWeight(.medium).frame(maxWidth: .infinity)
                    .foregroundStyle(AceTheme.Colours.onAccent)
            }
            .buttonStyle(.borderedProminent).tint(AceTheme.Colours.accent)
            .controlSize(.large).buttonBorderShape(.capsule)
            .disabled(!model.canOperate)
            .accessibilityIdentifier("transfer.send")
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
    }

    /// The default folder there, or one chosen among that machine's folders when this phone is
    /// connected to it.
    @ViewBuilder private func folderRow(_ machine: TransferSheetState.Machine) -> some View {
        let shown = parent.map { ($0 as NSString).lastPathComponent } ?? "Default"
        if let there = others.client(machine.hostId), there.connection == "ready" {
            NavigationLink {
                TransferFolderPicker(client: there, machine: machine.name, chosen: parent) { parent = $0 }
            } label: { InsetRow("Folder", systemImage: nil, value: shown) }
            .accessibilityIdentifier("transfer.folder")
        } else {
            InsetRow("Folder", systemImage: nil, value: shown).accessibilityIdentifier("transfer.folder")
        }
    }
}

extension View {
    /// Shows the Continue on (`thread`) or Open on (`project`) sheet while the bridge has one of
    /// that kind open; swiping it away closes it there too.
    func transferSheet(model: ClientModel, kind: String) -> some View {
        sheet(isPresented: Binding(get: { model.transfers.sheet?.kind == kind }, set: { if !$0 { model.transfer(["kind": "close"]) } })) {
            if let sheet = model.transfers.sheet { TransferSheet(model: model, sheet: sheet) }
        }
    }
}
