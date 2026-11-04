import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// The one Live Activity for all of the person's agents. Lock Screen: the sentence ("2 need you
/// · 4 working") and up to three threads. Dynamic Island: the needs-you sparkle and its count
/// (or the working ring and its count), the most urgent mark when minimal, and when expanded the
/// approval waiting longest with Allow and Deny, or the threads.
struct AgentsActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentsActivityAttributes.self) { context in
            LockActivityView(summary: context.state, stale: context.isStale)
                .activityBackgroundTint(nil)
        } dynamicIsland: { context in
            let summary = context.state
            let stale = context.isStale
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    SummaryGlyph(summary: summary, size: LockType.islandGlyph)
                        .padding(.leading, AceTheme.Spacing.xs)
                }
                DynamicIslandExpandedRegion(.center) {
                    LockHeadline(summary: summary, stale: stale, trailing: "")
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if let request = summary.request, summary.current, !stale {
                        RequestView(request: request)
                    } else {
                        LockRowsList(summary: summary.limited(3), stale: stale)
                    }
                }
            } compactLeading: {
                SummaryGlyph(summary: summary, size: LockType.islandGlyph)
            } compactTrailing: {
                CompactCount(summary: summary)
            } minimal: {
                SummaryGlyph(summary: summary, size: LockType.islandGlyph)
            }
            .widgetURL(summary.rows.first.flatMap { URL(string: $0.link) })
        }
    }
}

/// The Lock Screen banner: the sentence, then the threads.
struct LockActivityView: View {
    let summary: LockSummary
    let stale: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            LockHeadline(summary: summary, stale: stale)
            LockRowsList(summary: summary.limited(3), stale: stale)
        }
        .padding(AceTheme.Spacing.lg)
        .widgetURL(summary.rows.first.flatMap { URL(string: $0.link) })
    }
}

struct LockRowsList: View {
    let summary: LockSummary
    let stale: Bool
    var body: some View {
        if !summary.rows.isEmpty {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
                ForEach(summary.rows) { row in
                    let view = LockRowView(row: row, current: summary.current && !stale)
                    if let url = URL(string: row.link) { Link(destination: url) { view } } else { view }
                }
            }
        }
    }
}

/// The count beside the compact mark: how many need the person, otherwise how many work.
struct CompactCount: View {
    let summary: LockSummary
    var body: some View {
        let needs = summary.needsYou > 0
        let count = needs ? summary.needsYou : summary.working
        Text(count.formatted())
            .font(LockType.body.weight(LockType.strong))
            .monospacedDigit()
            .foregroundStyle(needs ? AceTheme.RowStatus.needsYou : AceTheme.Colours.mutedForeground)
            .opacity(count == 0 ? 0 : 1)
            .accessibilityLabel(summary.headline)
    }
}

/// The approval waiting longest: who asks and what for, the command in one line, then Deny and
/// Allow. Allow is the one accent; both answer on the machine that asked, after it re-reads the
/// request, and anything but a confirmed answer comes back as a quiet notification.
struct RequestView: View {
    let request: LockRequest
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(request.sentence)
                    .font(LockType.body.weight(LockType.strong))
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .lineLimit(1)
                Text(request.detail.isEmpty ? request.title : "\(request.title) · \(request.detail)")
                    .font(request.code ? LockType.code : LockType.meta)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            HStack(spacing: AceTheme.Spacing.sm) {
                Button(intent: AnswerRequestIntent(request, allow: false)) {
                    Text("Deny").frame(maxWidth: .infinity)
                }
                .tint(AceTheme.Colours.mutedForeground)
                Button(intent: AnswerRequestIntent(request, allow: true)) {
                    Text("Allow").fontWeight(LockType.strong).frame(maxWidth: .infinity)
                }
                .tint(AceTheme.Colours.accent)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .controlSize(.large)
            .font(LockType.body)
        }
    }
}
