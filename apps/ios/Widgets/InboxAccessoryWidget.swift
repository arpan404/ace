import SwiftUI
import WidgetKit

/// The Lock Screen's own widgets: a circle with how many threads need the person, and a line
/// with the sentence and the top thread. Both open ace at that thread.
struct InboxAccessoryWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "app.ace.ios.inbox.accessory", provider: LockProvider()) { entry in
            InboxAccessoryView(entry: entry)
                .containerBackground(.clear, for: .widget)
        }
        .configurationDisplayName("Needs you")
        .description("How many threads need you, and the first of them.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular])
    }
}

struct InboxAccessoryView: View {
    let entry: LockEntry
    @Environment(\.widgetFamily) private var family
    var body: some View {
        let summary = entry.summary ?? .empty
        let stale = entry.date.timeIntervalSince(summary.updatedAt) > LockSummary.freshFor || !summary.current
        Group {
            if family == .accessoryCircular { circle(summary, stale: stale) } else { rectangle(summary, stale: stale) }
        }
        .widgetURL(summary.rows.first.flatMap { URL(string: $0.link) })
    }

    /// The sparkle over the count; a dash when the count isn't known.
    private func circle(_ summary: LockSummary, stale: Bool) -> some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: RowStatusMark.symbol("sparkle") ?? "sparkle").font(LockType.meta)
                Text(entry.summary == nil ? "–" : summary.needsYou.formatted())
                    .font(LockType.title.weight(LockType.strong))
                    .monospacedDigit()
            }
        }
        .widgetAccentable()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(entry.summary == nil ? "Open ace to see your agents" : summary.spokenHeadline)
    }

    /// The sentence, then the thread to look at first.
    private func rectangle(_ summary: LockSummary, stale: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(entry.summary == nil ? "ace" : summary.headline)
                .font(LockType.body.weight(LockType.strong))
                .widgetAccentable()
                .lineLimit(1)
            if let top = summary.rows.first {
                Text(top.title).font(LockType.body).lineLimit(2)
            } else if entry.summary == nil {
                Text("Open ace to see your agents").font(LockType.body).lineLimit(2)
            }
            if stale, entry.summary != nil {
                Text("as of \(summary.updatedAt.formatted(date: .omitted, time: .shortened))").font(LockType.caption)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
