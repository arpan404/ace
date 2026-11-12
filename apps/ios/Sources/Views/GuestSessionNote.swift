import SwiftUI

/// Where a guest session's composer would be (ADR 0105): agents on another machine use this
/// one's tools through the thread, and nobody here talks to them, so one line says whose work it
/// is (the bridge's words), with Stop while they work. Requests waiting for the person still show
/// above it, so they can be answered from the phone too.
struct GuestSessionNote: View {
    let line: String
    /// Stop is offered: their work runs and this pairing may act.
    let canStop: Bool
    let stopping: Bool
    let stop: () -> Void
    var body: some View {
        HStack(spacing: AceTheme.Spacing.md) {
            Label(line, ace: .desktop)
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .lineLimit(2)
            Spacer(minLength: AceTheme.Spacing.sm)
            if canStop || stopping {
                Button(stopping ? "Stopping…" : "Stop", action: stop)
                    .buttonStyle(.textAction()).disabled(stopping)
                    .frame(minHeight: AceDesign.Size.tap)
                    .accessibilityIdentifier("thread.guest.stop")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("thread.guest")
    }
}
