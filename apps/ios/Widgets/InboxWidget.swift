import SwiftUI
import WidgetKit

/// The snapshot the app last wrote (`LockSnapshotStore`), read fresh for every timeline.
struct LockEntry: TimelineEntry {
    let date: Date
    /// Nil before the app has written one: the widget asks to open ace.
    let summary: LockSummary?
}

struct LockProvider: TimelineProvider {
    /// The app writes a new snapshot and reloads widgets whenever the inbox changes; this
    /// re-read only moves the "as of" check along when the app is away.
    static let reread: TimeInterval = 15 * 60
    func placeholder(in context: Context) -> LockEntry { LockEntry(date: .now, summary: .preview) }
    func getSnapshot(in context: Context, completion: @escaping (LockEntry) -> Void) {
        completion(LockEntry(date: .now, summary: context.isPreview ? LockSnapshotStore.read() ?? .preview : LockSnapshotStore.read()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<LockEntry>) -> Void) {
        let now = Date.now
        completion(Timeline(entries: [LockEntry(date: now, summary: LockSnapshotStore.read())], policy: .after(now.addingTimeInterval(Self.reread))))
    }
}

/// The inbox on the Home Screen. Small: how many need you and the top thread. Medium: the
/// sentence and three threads. Large: six. Each thread opens in ace.
struct InboxWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "app.ace.ios.inbox", provider: LockProvider()) { entry in
            InboxWidgetView(entry: entry)
                .containerBackground(AceTheme.Colours.background, for: .widget)
        }
        .configurationDisplayName("Inbox")
        .description("What needs you and what's working.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct InboxWidgetView: View {
    let entry: LockEntry
    @Environment(\.widgetFamily) private var family
    var body: some View {
        if let summary = entry.summary {
            switch family {
            case .systemSmall: SmallInbox(summary: summary, stale: stale(summary))
            case .systemLarge: ListInbox(summary: summary.limited(6), stale: stale(summary))
            default: ListInbox(summary: summary.limited(3), stale: stale(summary))
            }
        } else {
            Text("Open ace to see your agents here.")
                .font(LockType.body)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
    /// Past the Live Activity's own stale age, the snapshot reads as "as of".
    private func stale(_ summary: LockSummary) -> Bool { entry.date.timeIntervalSince(summary.updatedAt) > LockSummary.freshFor }
}

/// The count of threads that need the person, then the one to look at first.
struct SmallInbox: View {
    let summary: LockSummary
    let stale: Bool
    var body: some View {
        let needs = summary.needsYou > 0
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.xs) {
                SummaryGlyph(summary: summary, size: LockType.islandGlyph)
                Text((needs ? summary.needsYou : summary.working).formatted())
                    .font(LockType.count)
                    .monospacedDigit()
                    .foregroundStyle(AceTheme.Colours.foreground)
            }
            Text(needs ? (summary.needsYou == 1 ? "needs you" : "need you") : summary.working > 0 ? "working" : summary.headline)
                .font(LockType.meta)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .lineLimit(1)
            Spacer(minLength: 0)
            if let top = summary.rows.first {
                Text(top.title)
                    .font(LockType.body)
                    .foregroundStyle(top.needsYou ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                    .lineLimit(2)
            }
            if !summary.current || stale {
                Text("as of \(summary.updatedAt.formatted(date: .omitted, time: .shortened))")
                    .font(LockType.caption)
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(summary.rows.first.flatMap { URL(string: $0.link) })
        .accessibilityElement(children: .combine)
    }
}

/// The sentence, then the threads, each a link.
struct ListInbox: View {
    let summary: LockSummary
    let stale: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
            LockHeadline(summary: summary, stale: stale)
            if summary.rows.isEmpty {
                Text(summary.current ? "Threads that need you show here." : "Open ace to check your machines.")
                    .font(LockType.body)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
            } else {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
                    ForEach(summary.rows) { row in
                        let view = LockRowView(row: row, current: summary.current && !stale)
                        if let url = URL(string: row.link) { Link(destination: url) { view } } else { view }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

extension LockSummary {
    /// The widget gallery's example: what a working afternoon looks like.
    static var preview: LockSummary {
        let now = Date.now
        func row(_ id: String, _ title: String, _ icon: String, _ tone: String, _ meaning: String, since: TimeInterval? = nil, needs: Bool = false) -> LockRow {
            LockRow(id: id, hostId: "", title: title, icon: icon, tone: tone, meaning: meaning,
                    since: since.map { now.addingTimeInterval(-$0) }, link: "ace://thread/\(id)", needsYou: needs)
        }
        return LockSummary(needsYou: 2, working: 3, rows: [
            row("a", "Fleet map wire paths", "approve", "needs-you", "Needs approval", needs: true),
            row("b", "Ship the iOS composer fix", "question", "needs-you", "Has a question", needs: true),
            row("c", "Keep the composer above the keyboard", "working", "working", "Working", since: 252),
            row("d", "Remote network toggles", "agents", "waiting", "Waiting on 2 agents", since: 1080),
            row("e", "Usage limits as a quiet line", "working", "working", "Working", since: 64),
            row("f", "Snooze wake-ups", "done", "finished", "Finished"),
        ], current: true, busy: true, updatedAt: now)
    }
}
