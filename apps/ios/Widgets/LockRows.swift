import SwiftUI
import WidgetKit

/// One thread on the lock screen or a widget, as the inbox row draws it: the status mark, the
/// title (full ink only when it needs the person, muted otherwise), and the system's running
/// time for live work. No status words: the mark says it, and VoiceOver reads its meaning.
struct LockRowView: View {
    let row: LockRow
    /// False when the summary isn't current: a running time would keep counting on a guess.
    let current: Bool
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            if row.icon == "none" { Color.clear.frame(width: LockType.glyph + 2, height: LockType.glyph + 2) }
            else { RowStatusMark(kind: row.icon, tone: row.tone, count: row.count, size: LockType.glyph) }
            Text(row.title)
                .font(LockType.body)
                .foregroundStyle(row.needsYou ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if current, let since = row.since {
                RunningTime(since: since)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.meaning.isEmpty ? row.title : "\(row.title), \(row.meaning)")
    }
}

/// How long live work has run, counted by the system (no ticking state of ours).
struct RunningTime: View {
    let since: Date
    var body: some View {
        Text(timerInterval: since...Date.distantFuture, countsDown: false)
            .font(LockType.meta)
            .monospacedDigit()
            .foregroundStyle(AceTheme.Colours.subtleForeground)
            .multilineTextAlignment(.trailing)
            .frame(maxWidth: 56, alignment: .trailing)
    }
}

/// The summary's one sentence, with "as of" its time when it isn't current, so a lock screen
/// never shows old counts as fresh.
struct LockHeadline: View {
    let summary: LockSummary
    let stale: Bool
    var trailing = "ace"
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
            Text(summary.headline)
                .font(LockType.body.weight(LockType.strong))
                .foregroundStyle(AceTheme.Colours.foreground)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Group {
                if summary.current && !stale { Text(trailing) }
                else { Text("as of \(summary.updatedAt.formatted(date: .omitted, time: .shortened))") }
            }
            .font(LockType.meta)
            .foregroundStyle(AceTheme.Colours.subtleForeground)
            .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(summary.current && !stale ? summary.headline : "\(summary.headline), as of \(summary.updatedAt.formatted(date: .omitted, time: .shortened))")
    }
}

/// The mark for the whole summary: the needs-you sparkle while anything waits on the person,
/// otherwise the most urgent row's own mark, otherwise the quiet working ring.
struct SummaryGlyph: View {
    let summary: LockSummary
    let size: CGFloat
    var body: some View {
        if summary.needsYou > 0 { RowStatusMark(kind: "sparkle", tone: "needs-you", size: size) }
        else if let top = summary.rows.first, top.icon != "none" { RowStatusMark(kind: top.icon, tone: top.tone, count: top.count, size: size) }
        else { RowStatusMark(kind: "working", tone: "idle", size: size) }
    }
}
