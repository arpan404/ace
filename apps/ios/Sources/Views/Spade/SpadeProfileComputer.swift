import SwiftUI

/// Computer: what the bot drives (web's `profile-computer.tsx`). One line for its state, then a
/// row for each surface it has used (the ones in use now marked) and its files, each opening its
/// page: the browser or screen live, the terminal, the files to browse and edit. Services show
/// once the bot has started one. Every page follows the computer with one shared watch, so who
/// has it reads the same on each.
struct SpadeProfileComputer: View {
    let client: ClientModel
    let profile: SpadeProfile
    let retry: () -> Void
    @State private var watch: SpadeComputerWatch
    private var computer: SpadeProfile.Computer { profile.computer }

    init(client: ClientModel, profile: SpadeProfile, retry: @escaping () -> Void) {
        self.client = client
        self.profile = profile
        self.retry = retry
        _watch = State(initialValue: SpadeComputerWatch(agent: profile.id))
    }

    /// The surfaces Spade listed as used, then Files, which is always there.
    private var surfaces: [SpadeProfile.Surface] {
        var shown = computer.surfaces
        if !shown.contains(where: { $0.name == "Files" }) { shown.append(SpadeProfile.Surface(name: "Files", line: nil, live: false)) }
        return shown
    }

    var body: some View {
        Section {
            Text(computer.line)
                .aceFont(AceDesign.TextRole.rowTitle)
                .foregroundStyle(AceDesign.Ink.primary)
                .accessibilityIdentifier("spade.profile.computer")
            ForEach(surfaces, id: \.self) { surface in
                NavigationLink { page(surface.name) } label: { row(surface) }
                    .accessibilityIdentifier("spade.computer.\(surface.name.lowercased())")
            }
        }
        // Services show once the bot has started one, or when they couldn't be read.
        if computer.services.failed || !computer.services.items.isEmpty {
            Section("Services") {
                SpadeProfileRows(part: computer.services, none: "", failed: "Couldn't read the services.",
                                 retry: retry) { service in
                    NavigationLink {
                        SpadeComputerServices(model: client, agent: profile.id, name: profile.name)
                    } label: {
                        LabeledContent(service.name) {
                            Text(service.words)
                                .aceFont(AceDesign.TextRole.meta)
                                .foregroundStyle(service.running ? AceDesign.Status.working : AceDesign.Ink.muted)
                        }
                    }
                }
            }
        }
    }

    private func row(_ surface: SpadeProfile.Surface) -> some View {
        LabeledContent {
            if surface.live {
                Text("In use").aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Status.working)
            }
        } label: {
            Label {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    Text(surface.name).aceFont(AceDesign.TextRole.rowTitle)
                    if let line = surface.line {
                        Text(line).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted).lineLimit(1)
                    }
                }
            } icon: { AceIcon(Self.icon(surface.name), size: AceDesign.Size.barIcon) }
        }
    }

    @ViewBuilder private func page(_ name: String) -> some View {
        switch name {
        case "Browser":
            SpadeComputerScreen(model: client, watch: watch, kind: "browser", name: profile.name, face: profile.face)
        case "Screen":
            SpadeComputerScreen(model: client, watch: watch, kind: "screen", name: profile.name, face: profile.face)
        case "Terminal":
            SpadeComputerTerminal(model: client, watch: watch, name: profile.name, face: profile.face)
        default:
            SpadeComputerFiles(model: client, watch: watch, name: profile.name, face: profile.face)
        }
    }

    private static func icon(_ name: String) -> AceIcon.Name {
        switch name {
        case "Browser": .compass
        case "Screen": .monitor
        case "Terminal": .terminal
        default: .folderSimple
        }
    }
}
