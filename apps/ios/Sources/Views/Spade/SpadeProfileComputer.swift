import SwiftUI

/// Computer: what the bot drives. One line for its state, the surfaces it has used (the ones
/// in use now marked), and the services it keeps running.
struct SpadeProfileComputer: View {
    let computer: SpadeProfile.Computer
    let retry: () -> Void

    var body: some View {
        Section {
            Text(computer.line)
                .aceFont(AceDesign.TextRole.rowTitle)
                .foregroundStyle(AceDesign.Ink.primary)
                .accessibilityIdentifier("spade.profile.computer")
            ForEach(computer.surfaces, id: \.self) { surface in
                LabeledContent {
                    if surface.live {
                        Text("In use").aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Status.working)
                    }
                } label: {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                        Text(surface.name).aceFont(AceDesign.TextRole.rowTitle)
                        if let line = surface.line {
                            Text(line).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted).lineLimit(1)
                        }
                    }
                }
            }
        }
        // Services show once the bot has started one, or when they couldn't be read.
        if computer.services.failed || !computer.services.items.isEmpty {
            Section("Services") {
                SpadeProfileRows(part: computer.services, none: "", failed: "Couldn't read the services.",
                                 retry: retry) { service in
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
