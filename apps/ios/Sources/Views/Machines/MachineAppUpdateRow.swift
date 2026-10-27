import SwiftUI

/// The desktop app's version on this machine and one quiet line about its update. Read-only:
/// installing and restarting stay on the computer. Restart required is the only state drawn as
/// needing the person, never as a failure. Words come from `bridge/machine-app-update.ts`.
struct MachineAppUpdateRow: View {
    let update: MachineAppUpdateInfo

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            LabeledContent("Desktop app", value: update.version)
            if let line = update.line {
                Group {
                    if update.needsYou {
                        StateLabel(status: StatusDisplay(label: line, token: "needsYou"))
                    } else {
                        Text(line).foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                }
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .transition(.opacity)
            }
        }
        .animation(.smooth, value: update)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("machine.appUpdate")
    }
}
