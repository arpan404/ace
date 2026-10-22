import SwiftUI

/// The tools each paired machine offers, reached from Settings › Tools on that machine's own
/// connection.
enum SettingsTool: String, Hashable, CaseIterable {
    case projects, automations, usage, skills, providers, sourceControl, prompts, computer, devices

    var title: String {
        switch self {
        case .projects: "Projects"
        case .automations: "Automations"
        case .usage: "Usage"
        case .skills: "Skills and plugins"
        case .providers: "Providers"
        case .sourceControl: "Source control"
        case .prompts: "Prompts"
        case .computer: "Computer use"
        case .devices: "Simulators and devices"
        }
    }
    var icon: AceIcon.Name {
        switch self {
        case .projects: .folder
        case .automations: .clockCounterClockwise
        case .usage: .chartBar
        case .skills: .bookOpen
        case .providers: .terminalWindow
        case .sourceControl: .gitBranch
        case .prompts: .notePencil
        case .computer: .appWindow
        case .devices: .deviceMobile
        }
    }
    /// Kept from the old Browse sheet so automation finds the same rows.
    var identifier: String {
        switch self {
        case .projects: "library.projects"
        case .skills: "library.skills"
        case .computer: "library.computer"
        case .devices: "library.devices"
        default: "library.\(rawValue)"
        }
    }
    @MainActor @ViewBuilder func destination(_ model: ClientModel) -> some View {
        switch self {
        case .projects: ProjectsView(model: model)
        case .automations: AutomationsView(model: model)
        case .usage: UsageView(model: model)
        case .skills: SkillsLibraryView(model: model)
        case .providers: ProviderSettingsView(model: model)
        case .sourceControl: SourceControlView(model: model)
        case .prompts: PromptsView(model: model)
        case .computer: RemoteScreenView(model: model)
        case .devices: DevicesScreen(model: model, threadId: nil)
        }
    }
}

/// Settings › Tools: one machine's tools, with the machine to use them on when there are several.
struct SettingsTools: View {
    let inbox: MachineInbox
    @Binding var machine: String
    private var hostId: String {
        inbox.sessions.contains { $0.hostId == machine } ? machine : inbox.sessions.first?.hostId ?? ""
    }

    var body: some View {
        if !inbox.sessions.isEmpty {
            Section {
                if inbox.sessions.count > 1 {
                    HStack {
                        SettingsLinkLabel(title: "Machine", icon: .desktop)
                        Picker("Machine", selection: Binding(get: { hostId }, set: { machine = $0 })) {
                            ForEach(inbox.sessions) { Text(inbox.name($0.hostId)).tag($0.hostId) }
                        }
                        .labelsHidden().pickerStyle(.menu).tint(AceTheme.Colours.mutedForeground)
                    }
                    .accessibilityIdentifier("settings.tools.machine")
                }
                ForEach(SettingsTool.allCases, id: \.self) { tool in
                    NavigationLink(value: SettingsRoute.tool(tool, machine: hostId)) { SettingsLinkLabel(title: tool.title, icon: tool.icon) }
                        .accessibilityIdentifier(tool.identifier)
                }
            } header: {
                SettingsHeader("Tools", note: inbox.client(hostId)?.connection != "ready" ? "Offline. These open once this phone reaches it." : nil)
            }
            .settingsRow()
        }
    }
}
