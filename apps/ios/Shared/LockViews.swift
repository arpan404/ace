import AppIntents
import SwiftUI
import WidgetKit

// The views the Live Activity and the widgets draw, compiled into the app too so the debug
// lock-screen gallery (`--lock-gallery`) renders exactly what the extension shows.

/// The type roles of `AceDesign.Typeface` (design-language §3), which the extension can't link:
/// system text styles, so Dynamic Type applies, and the two weights.
enum LockType {
    static let title = Font.body
    static let body = Font.callout
    static let meta = Font.footnote
    static let caption = Font.caption2
    static let code = Font.system(.footnote, design: .monospaced)
    static let strong = Font.Weight.semibold
    /// The small widget's count: the largest number on any ace surface, still a system style.
    static let count = Font.system(.largeTitle, design: .default).weight(.semibold)
    /// A status mark beside a row title, and in the Dynamic Island.
    static let glyph: CGFloat = 14
    static let islandGlyph: CGFloat = 16
    /// Every tap target's height (`AceDesign.Size.tap`).
    static let tap: CGFloat = 44
}

/// One thread on the lock screen or a widget, as the inbox row draws it: the status mark, the
/// title (full ink only when it needs the person, muted otherwise), and the system's running
/// time for live work. No status words: the mark says it, and VoiceOver reads its meaning.
struct LockRowView: View {
    let row: LockRow
    /// False when the summary is last known or past its stale date: a running time would keep
    /// counting on a guess.
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
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .multilineTextAlignment(.trailing)
            .frame(maxWidth: 56, alignment: .trailing)
    }
}

/// The summary's one sentence, then "as of" its time when it isn't fresh, so a lock screen
/// never shows old counts as fresh, or the machines out of reach when only the others counted.
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
            Text(summary.note(stale: stale, fresh: trailing))
                .font(LockType.meta)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .lineLimit(1)
                .layoutPriority(1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(summary.spokenHeadline(stale: stale))
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
                    let view = LockRowView(row: row, current: !summary.asOf(stale: stale))
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
    /// The thread in meta ink, then the command in mono: mono only for code.
    private var detail: Text {
        let thread = Text(request.title).font(LockType.meta).foregroundStyle(AceTheme.Colours.mutedForeground)
        guard !request.detail.isEmpty else { return thread }
        let line = Text(request.detail).font(request.code ? LockType.code : LockType.meta).foregroundStyle(AceTheme.Colours.mutedForeground)
        return Text("\(thread)\(Text(" · ").font(LockType.meta).foregroundStyle(AceTheme.Colours.mutedForeground))\(line)")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(request.sentence)
                    .font(LockType.body.weight(LockType.strong))
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .lineLimit(1)
                detail
                    .lineLimit(1)
            }
            HStack(spacing: AceTheme.Spacing.sm) {
                Button(intent: AnswerRequestIntent(request, allow: false)) { Text("Deny") }
                    .buttonStyle(LockCapsuleButton(primary: false))
                Button(intent: AnswerRequestIntent(request, allow: true)) { Text("Allow") }
                    .buttonStyle(LockCapsuleButton(primary: true))
            }
        }
    }
}

/// A request's answer as a capsule: Allow takes the one accent; Deny a quiet fill in full ink.
/// 44 points tall, as every tap target is.
struct LockCapsuleButton: ButtonStyle {
    let primary: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(LockType.body.weight(primary ? LockType.strong : .regular))
            .foregroundStyle(primary ? AceTheme.Colours.onAccent : AceTheme.Colours.foreground)
            .frame(maxWidth: .infinity, minHeight: LockType.tap)
            .background(primary ? AceTheme.Colours.accent : AceTheme.Colours.fill, in: Capsule())
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}
