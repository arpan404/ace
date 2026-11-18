import SwiftUI

/// The desktop app's version on this machine and one quiet line about its update. Read-only:
/// installing and restarting stay on the computer. Restart required is the only state drawn as
/// needing the person, never as a failure. Words come from `bridge/machine-app-update.ts`.
struct MachineAppUpdateRow: View {
    let update: MachineAppUpdateInfo
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            // Not LabeledContent: at accessibility sizes its value and the line under it ran off the
            // row's edge. Side by side it reads as the rows above; stacked, everything wraps.
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: AceTheme.Spacing.xxs))
                : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: AceDesign.Space.related))
            layout {
                Text("Desktop app").foregroundStyle(AceDesign.Ink.primary)
                if !typeSize.isAccessibilitySize { Spacer(minLength: AceDesign.Space.related) }
                Text(update.version).foregroundStyle(AceDesign.Ink.muted)
            }
            if let line = update.line {
                Group {
                    if update.needsYou, typeSize.isAccessibilitySize {
                        // The status label keeps to one line; this one has to wrap.
                        Text(line).foregroundStyle(AceTheme.StatusText.needsYou)
                    } else if update.needsYou {
                        StateLabel(status: StatusDisplay(label: line, token: "needsYou"))
                    } else {
                        Text(line).foregroundStyle(AceDesign.Ink.muted)
                    }
                }
                .font(AceDesign.Typeface.meta)
                .fixedSize(horizontal: false, vertical: true)
                .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .smoothChange(update)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("machine.appUpdate")
    }
}
