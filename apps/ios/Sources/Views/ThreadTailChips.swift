import SwiftUI

/// Counts come from daemon metadata; a test chip never infers success from a finished turn.
struct ThreadTailChips: View {
    let metadata: ThreadRow?
    let changes: () -> Void
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            if let diff = metadata?.diff, diff.files > 0 {
                Button(action: changes) {
                    Label("\(diff.files) files · +\(diff.additions) −\(diff.deletions)", systemImage: "doc.text")
                        .padding(.horizontal, AceTheme.Spacing.sm).padding(.vertical, AceTheme.Spacing.xs)
                        .background(AceTheme.Colours.fill, in: Capsule())
                        .frame(minHeight: AceTheme.Dimensions.touchTarget)
                }.buttonStyle(.plain).accessibilityIdentifier("thread.fileChip")
            }
            if metadata?.testsRunning == true {
                Label("Running tests", systemImage: "testtube.2")
                    .padding(.horizontal, AceTheme.Spacing.sm).padding(.vertical, AceTheme.Spacing.xs)
                    .background(AceTheme.Colours.fill, in: Capsule())
            }
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
    }
}
