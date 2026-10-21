import SwiftUI

/// The live turn's one status line at the top of its flow, under its ask (DESIGN.md §8): muted
/// "Working for 1m 14s · 2 subagents working" over a hairline, where "Worked for" stands once the
/// turn settles. A request reads "Waiting for your approval" beside the needs-you glyph (the
/// request itself is in the composer's strip). While the main agent only waits on its subagents
/// or commands the line steps aside and the strip says so. Words and timer origin are the
/// bridge's shared live line.
struct LiveLine: View {
    let activity: ActivityRow?
    var body: some View {
        if let activity, activity.inline {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                line(activity)
                    .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, minHeight: AceTheme.Spacing.xxxl, alignment: .leading)
                Hairline()
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.updatesFrequently)
            .accessibilityIdentifier("thread.live")
        }
    }
    @ViewBuilder private func line(_ activity: ActivityRow) -> some View {
        if activity.tone == "working", let since = activity.since, !activity.lead.isEmpty {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let words = "\(activity.lead) \(Elapsed.words(since: since, now: context.date))"
                Text(activity.context.isEmpty ? words : "\(words) · \(activity.context)")
                    .monospacedDigit()
            }
        } else if activity.tone == "needs-you" {
            HStack(spacing: AceTheme.Spacing.sm) {
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AceTheme.Status.needsYou)
                    .accessibilityHidden(true)
                Text(activity.label)
            }
        } else {
            Text(activity.label)
        }
    }
}

/// "1m 14s": time since a moment the bridge gave in ms since 1970, as the web counts it.
enum Elapsed {
    static func words(since: Double, now: Date) -> String {
        let seconds = max(1, Int(now.timeIntervalSince1970 - since / 1000))
        return Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .narrow))
    }
}

/// The `--border` hairline under a line.
struct Hairline: View {
    var body: some View {
        Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
            .accessibilityHidden(true)
    }
}
