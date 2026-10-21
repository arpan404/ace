import SwiftUI

/// The phone's navigation drawer. Machine tools use the same selected connection throughout.
struct LibrarySheet: View {
    let inbox: MachineInbox
    let openSettings: () -> Void
    let openMachines: () -> Void
    let openArchive: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var machineId: String
    init(inbox: MachineInbox, openSettings: @escaping () -> Void, openMachines: @escaping () -> Void, openArchive: @escaping () -> Void) {
        self.inbox = inbox; self.openSettings = openSettings; self.openMachines = openMachines; self.openArchive = openArchive
        _machineId = State(initialValue: inbox.sessions.first?.hostId ?? "")
    }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { dismiss() } label: { Label("Threads", systemImage: "bubble.left.and.bubble.right") }
                    Button(action: openArchive) { Label("Archived threads", systemImage: "archivebox") }
                }
                if let model = inbox.client(machineId) {
                    Section {
                        if inbox.sessions.count > 1 {
                            Picker("Machine", selection: $machineId) {
                                ForEach(inbox.sessions) { Text(inbox.name($0.hostId)).tag($0.hostId) }
                            }
                        }
                        NavigationLink { ProjectsView(model: model) } label: { Label("Projects", systemImage: "folder") }
                            .accessibilityIdentifier("library.projects")
                        NavigationLink { AutomationsView(model: model) } label: { Label("Automations", systemImage: "clock.arrow.circlepath") }
                        NavigationLink { UsageView(model: model) } label: { Label("Usage", systemImage: "chart.bar") }
                        NavigationLink { SkillsLibraryView(model: model) } label: { Label("Skills and plugins", systemImage: "book") }
                            .accessibilityIdentifier("library.skills")
                        NavigationLink { ProviderSettingsView(model: model) } label: { Label("Providers and accounts", systemImage: "person.crop.circle") }
                        NavigationLink { SourceControlView(model: model) } label: { Label("Source control", systemImage: "arrow.triangle.branch") }
                        NavigationLink { PromptsView(model: model) } label: { Label("Prompts", systemImage: "text.alignleft") }
                        NavigationLink { RemoteScreenView(model: model) } label: { Label("Computer use", systemImage: "macwindow") }
                            .accessibilityIdentifier("library.computer")
                        NavigationLink { RemoteDevicesView(model: model) } label: { Label("Simulators and devices", systemImage: "iphone.and.arrow.forward") }
                            .accessibilityIdentifier("library.devices")
                    } header: {
                        HStack {
                            Text(inbox.name(machineId))
                            Spacer()
                            if model.connection != "ready" { Text("Offline").foregroundStyle(AceTheme.Colours.subtleForeground) }
                        }
                    }
                }
                Section {
                    Button(action: openMachines) { Label("Machines", systemImage: "desktopcomputer") }.accessibilityIdentifier("inbox.machines")
                    Button(action: openSettings) { Label("Settings", systemImage: "gearshape") }.accessibilityIdentifier("inbox.settings")
                }
            }
            .foregroundStyle(AceTheme.Colours.foreground)
            .navigationTitle("Browse").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .onDisappear {
            inbox.client(machineId)?.action(["type": "native.devices.close"])
            inbox.client(machineId)?.action(["type": "native.screen.close"])
        }
        .presentationDetents([.large]).presentationDragIndicator(.visible)
    }
}
