import SwiftUI

/// The thread's live state, centred in a glass capsule above the composer: "Working 1m 14s", or
/// "Waiting on 2 · 1 command · 2 queued" while the root waits on its subagents. The words and the
/// timer's origin are the bridge's shared live line; Stop lives in the composer, never here.
struct LiveCapsule: View {
    let activity: ActivityRow?
    /// Follow-ups waiting in the daemon's queue.
    let queued: Int
    /// A Stop is on its way.
    let stopping: Bool
    /// Opens the queued messages.
    let openQueue: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm + AceTheme.Spacing.xxs) {
            if let activity {
                HStack(spacing: AceTheme.Spacing.sm) {
                    glyph(activity)
                    Text(stopping ? "Stopping…" : activity.label).lineLimit(1)
                    if let since = activity.since, activity.tone == "working", !activity.waiting {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            let seconds = max(1, Int(context.date.timeIntervalSince1970 - since / 1000))
                            Text(Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .narrow)))
                                .monospacedDigit()
                        }
                    }
                }
                .foregroundStyle(activity.tone == "needs-you" ? AceTheme.StatusText.needsYou : AceTheme.Colours.foreground)
                if !activity.commands.isEmpty {
                    divider
                    Label(activity.commands, systemImage: "apple.terminal").labelStyle(SegmentLabel())
                }
            }
            if queued > 0 {
                if activity != nil { divider }
                Button(action: openQueue) { Text("\(queued) queued") }
                    .buttonStyle(.plain).foregroundStyle(AceTheme.Colours.mutedForeground)
                    .accessibilityHint("Shows the queued messages")
                    .accessibilityIdentifier("capsule.queue")
            }
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
        .padding(.horizontal, AceTheme.Spacing.lg)
        .frame(height: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.xs)
        .aceGlass(in: Capsule())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("thread.live")
    }
    private var divider: some View {
        Rectangle().fill(AceTheme.Colours.separator).frame(width: AceTheme.Dimensions.border, height: AceTheme.Spacing.lg)
            .accessibilityHidden(true)
    }
    @ViewBuilder private func glyph(_ activity: ActivityRow) -> some View {
        switch activity.tone {
        case "needs-you": Image(systemName: "exclamationmark.circle").foregroundStyle(AceTheme.Status.needsYou)
        case "held", "paused": Image(systemName: "pause.circle").foregroundStyle(AceTheme.Colours.mutedForeground)
        default:
            if activity.waiting { Image(systemName: "hourglass") }
            else if reduceMotion { Image(systemName: "circle.dashed") }
            else { ProgressView().controlSize(.small).tint(AceTheme.Colours.foreground) }
        }
    }
}

/// "⌘ 1 command": a muted segment with its glyph.
private struct SegmentLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) { configuration.icon; configuration.title }
            .foregroundStyle(AceTheme.Colours.mutedForeground)
    }
}
