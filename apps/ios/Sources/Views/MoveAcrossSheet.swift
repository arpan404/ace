import SwiftUI

/// Moving threads picked on several machines: a project lives on one machine, so each machine's
/// threads get a project of their own, chosen machine by machine. Move sends every machine that
/// has one; a machine left without a project, or not connected, keeps its threads where they are.
struct MoveAcrossSheet: View {
    let inbox: MachineInbox
    let ask: MoveAsk
    let move: ([MoveGroup]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var chosen: [String: ComposeProject] = [:]

    /// The project every one of `keys` is in, or nil when they differ.
    static func sharedProject(_ keys: [InboxKey], in inbox: MachineInbox) -> String? {
        let workspaces = Set(keys.compactMap { inbox.row($0)?.workspaceId })
        return workspaces.count == 1 ? workspaces.first : nil
    }

    private var groups: [MoveGroup] {
        ask.machines.compactMap { machine in
            chosen[machine.machineId].map { project in
                MoveGroup(keys: machine.ids.map { InboxKey(machineId: machine.machineId, id: $0) }, project: project)
            }
        }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(ask.machines.map { $0.machineId }, id: \.self) { machineId in
                    let keys = ask.keys.filter { $0.machineId == machineId }
                    Section {
                        row(machineId, keys: keys)
                    } header: {
                        InsetHeader("\(inbox.name(machineId)) · \(keys.count == 1 ? "1 thread" : "\(keys.count) threads")")
                    }
                }
                Section {} footer: {
                    Text("A project belongs to one machine, so each machine's threads move to a project there. Threads on a machine with no project chosen stay where they are.")
                }
            }
            .insetGroupedList()
            .navigationTitle("Move \(ask.keys.count) threads").navigationBarTitleDisplayMode(.inline)
            .escapeCloses { dismiss() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close").accessibilityIdentifier("move.close")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Move") { move(groups); dismiss() }
                        .disabled(groups.isEmpty)
                        .accessibilityIdentifier("move.confirm")
                }
            }
        }
        .tint(AceTheme.Colours.foreground)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }

    @ViewBuilder private func row(_ machineId: String, keys: [InboxKey]) -> some View {
        if let client = inbox.client(machineId) {
            NavigationLink {
                MoveProjectList(client: client, from: Self.sharedProject(keys, in: inbox)) { chosen[machineId] = $0 }
                    .navigationTitle("Project on \(inbox.name(machineId))").navigationBarTitleDisplayMode(.inline)
            } label: {
                LabeledContent("Project") {
                    Text(chosen[machineId]?.name ?? "Choose")
                        .foregroundStyle(chosen[machineId] == nil ? AceDesign.Ink.muted : AceDesign.Ink.primary)
                }
            }
            .accessibilityIdentifier("move.machine.\(machineId)")
        } else {
            Text("Not connected. Its threads stay where they are.")
                .foregroundStyle(AceDesign.Ink.muted)
        }
    }
}
