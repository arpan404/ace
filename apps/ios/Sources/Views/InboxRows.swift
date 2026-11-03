import SwiftUI

/// One thread in the inbox, as the desktop row reads: its status icon in its state's colour (no
/// status words), the title with the running time of live work or the age at rest, then the
/// project's name, with the machine (only when several are paired), running subagents and the
/// provider at the end. The state's meaning (`rowStatusLook`) is in the row's spoken name.
/// Branch and pull request live in the thread itself.
struct InboxThreadRow: View {
    @Environment(\.aceDensityId) private var densityId
    let row: ThreadRow
    let snoozed: Bool
    var machine: MachineMark? = nil
    var project: ProjectMarkLook? = nil
    @Environment(\.dynamicTypeSize) private var typeSize

    /// Old payloads without a look read quietly with the shared word.
    private var look: RowLook {
        row.look ?? RowLook(level: "quiet", word: row.status.label, tone: row.status.token, muted: true,
                            glyph: nil, since: nil, settled: false, subagents: max(0, row.agents - 1))
    }

    var body: some View {
        let look = look
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.row) {
            InboxRowMark(look: look).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + InboxRowMark.baseline }
            VStack(alignment: .leading, spacing: AceTheme.density(densityId).inboxLineGap) {
                HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
                    Text(row.title)
                        .aceFont(InboxRowType.title, relativeTo: .body)
                        // Semibold only while the thread needs the person, as on the desktop.
                        .fontWeight(look.strong == true ? AceDesign.Typeface.strong : AceDesign.Typeface.regular)
                        .foregroundStyle(look.settled ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground)
                        .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                    Spacer(minLength: AceDesign.Space.related)
                    InboxRowAge(row: row, look: look)
                }
                InboxRowLine(row: row, look: look, snoozed: snoozed, machine: machine, project: project)
            }
        }
        .padding(.horizontal, AceTheme.Spacing.rowInner)
        .padding(.vertical, AceTheme.density(densityId).inboxRowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        // The title, then what the icon means ("Needs approval"), as the desktop row names itself.
        .accessibilityLabel(spoken(look))
    }

    private func spoken(_ look: RowLook) -> String {
        let meaning = look.meaning ?? look.word
        return [row.title, meaning, row.project.isEmpty ? nil : row.project]
            .compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: ", ")
    }
}

/// The row's type: the title role for the thread's title and the body role for the line under
/// it (design language §3), as the system's lists set them.
enum InboxRowType {
    static let title = AceTheme.Typography.body
    static let line = AceTheme.Typography.rowTitle
}

/// The one status mark beside a row: the desktop row's status icon in its state's colour
/// (`RowStatusIcon`), nothing for a thread at rest. Older bridges without the icon draw a dot for
/// needs-you or failed and a turning ring for live work. Decorative; the line under the title
/// says it in words.
struct InboxRowMark: View {
    let look: RowLook
    /// Sits the mark's centre on the title's first line rather than on its baseline.
    nonisolated static let baseline: CGFloat = 4
    var body: some View {
        if let icon = look.icon {
            Group {
                if icon == "none" { Color.clear } else { RowStatusIcon(kind: icon, tone: look.iconTone ?? "idle", count: look.count) }
            }
            .frame(width: AceDesign.Size.lead)
            .accessibilityHidden(true)
        } else {
            legacy
        }
    }
    private var legacy: some View {
        let tone = AceTone(look.tone)
        return Group {
            switch look.level {
            case _ where look.level == "needs-you" || tone == .failed: Circle().fill(tone.mark).frame(width: AceDesign.Size.dot, height: AceDesign.Size.dot)
            case "active": InboxWorkingRing()
            default: Color.clear.frame(width: AceDesign.Size.dot, height: AceDesign.Size.dot)
            }
        }
        .frame(width: AceDesign.Size.lead)
        .accessibilityHidden(true)
    }
}

/// Live work's mark on rows from older bridges: an open ring, still (nothing animates on rows).
private struct InboxWorkingRing: View {
    /// The ring's drawing: open at the top, a fine stroke, the size of the needs-you dot.
    private static let gap: CGFloat = 0.12
    private static let stroke: CGFloat = 1.6
    var body: some View {
        Circle().trim(from: Self.gap, to: 1 - Self.gap)
            .stroke(AceTheme.Colours.mutedForeground, lineWidth: Self.stroke)
            .rotationEffect(.degrees(-90))
            .frame(width: AceDesign.Size.dot, height: AceDesign.Size.dot)
    }
}

/// The time on the title's line, as the shared look says (`rowStatusLook`'s mode): how long live
/// work has run, to the second ("1m 34s"); the age of a row at rest; a quiet word while syncing;
/// nothing where the icon says it alone (a request, a fresh failure, an unseen result).
struct InboxRowAge: View {
    let row: ThreadRow
    let look: RowLook
    var body: some View {
        if look.mode == "elapsed", let since = look.since {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                label(ActivityTime.running(since: Date(timeIntervalSince1970: since / 1000), now: context.date))
            }
        } else if look.mode == "icon" {
            EmptyView()
        } else if look.mode == "word", let word = look.word {
            label(word)
        } else {
            TimelineView(.everyMinute) { context in label(text(at: context.date)) }
        }
    }
    private func label(_ text: String) -> some View {
        Text(text).monospacedDigit()
            .aceFont(InboxRowType.line, relativeTo: .subheadline)
            .foregroundStyle(AceTheme.Colours.subtleForeground)
            .lineLimit(1).fixedSize()
    }
    private func text(at now: Date) -> String {
        if look.level == "active", let start = look.since ?? row.activityAt,
           let elapsed = ActivityTime.elapsed(since: Date(timeIntervalSince1970: start / 1000), now: now) {
            return elapsed
        }
        return ActivityTime.age(since: Date(timeIntervalSince1970: (row.activityAt ?? row.updatedAt) / 1000), now: now)
    }
}

/// The line under the title: the project's name, and for a snoozed row when it wakes, as the
/// desktop row says it where its status sits. No status words: the icon says it. At the end,
/// never wrapping: the machine's mark, running subagents and the provider's mark. When space
/// runs short the project name gives way first.
struct InboxRowLine: View {
    let row: ThreadRow
    let look: RowLook
    let snoozed: Bool
    let machine: MachineMark?
    let project: ProjectMarkLook?
    var body: some View {
        // Older bridges without the shared look keep their word.
        let word = snoozed && look.level != "needs-you" ? row.snoozedUntil.map(Self.wake) : look.icon == nil ? look.word : nil
        let named = !row.project.isEmpty
        HStack(alignment: .center, spacing: AceDesign.Space.tight) {
            if named {
                Text(row.project).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
            }
            if let word {
                Text((named ? "· " : "") + word)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .lineLimit(1)
                    .layoutPriority(1)
            }
            Spacer(minLength: AceDesign.Space.related)
            InboxRowMarks(row: row, look: look, machine: machine).fixedSize().layoutPriority(2)
        }
        .aceFont(InboxRowType.line, relativeTo: .subheadline)
    }
    /// When a snoozed row wakes: "Until 3:00 PM" today, else with the weekday.
    static func wake(_ until: Double) -> String {
        let date = Date(timeIntervalSince1970: until / 1000)
        let time = date.formatted(date: .omitted, time: .shortened)
        return Calendar.current.isDateInToday(date) ? "Until \(time)" : "Until \(date.formatted(.dateTime.weekday(.abbreviated))) \(time)"
    }
}

/// The row's trailing marks: the machine (named for VoiceOver), running subagents with the tree
/// icon, then the provider's mark (never with an account bubble: the preview names the account).
/// Settled rows grey them with the rest.
struct InboxRowMarks: View {
    let row: ThreadRow
    let look: RowLook
    let machine: MachineMark?
    var body: some View {
        HStack(spacing: AceDesign.Space.related) {
            if let machine {
                AceIcon(machine.glyph, size: AceDesign.Size.glyphMeta, relativeTo: .subheadline)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(machine.name)
            }
            if look.subagents > 0 {
                HStack(spacing: AceTheme.Spacing.xxs) {
                    AceIcon(.treeStructure, size: AceDesign.Size.glyphSmall, relativeTo: .subheadline)
                    Text(look.subagents.formatted()).monospacedDigit()
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(look.subagents) agents")
            }
            // The provider in its own colours at 80% (a one-colour mark in the foreground ink).
            ProviderMark(provider: row.provider, size: AceDesign.Size.icon, quiet: look.settled)
                .foregroundStyle(look.settled ? AceTheme.Colours.faintForeground : AceTheme.Colours.foreground)
                .opacity(look.settled ? 1 : AceDesign.Ink.markOpacity)
        }
        .foregroundStyle(look.settled ? AceTheme.Colours.faintForeground : AceTheme.Colours.subtleForeground)
    }
}

/// A send the SDK still holds, drawn like a thread row: its text, then the shared unsent
/// wording and the thread it goes to. A send that failed takes the needs-you dot.
struct InboxUnsentRow: View {
    @Environment(\.aceDensityId) private var densityId
    let entry: PendingRow
    let thread: ThreadRow?
    var body: some View {
        let tone = AceTone(entry.token ?? "neutral")
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.row) {
            Group {
                if tone == .needsYou { Circle().fill(tone.mark).frame(width: AceDesign.Size.dot, height: AceDesign.Size.dot) } else { Color.clear.frame(width: AceDesign.Size.dot, height: AceDesign.Size.dot) }
            }
            .frame(width: AceDesign.Size.lead).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + InboxRowMark.baseline }
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: AceTheme.density(densityId).inboxLineGap) {
                Text(entry.text).aceFont(InboxRowType.title, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.foreground).lineLimit(2)
                (Text(entry.label ?? "").foregroundStyle(tone == .needsYou ? tone.text : AceTheme.Colours.mutedForeground)
                 + Text(thread.map { " · \($0.title)" } ?? "").foregroundStyle(AceTheme.Colours.mutedForeground))
                    .aceFont(InboxRowType.line, relativeTo: .subheadline).lineLimit(1)
            }
        }
        .padding(.horizontal, AceTheme.Spacing.rowInner)
        .padding(.vertical, AceTheme.density(densityId).inboxRowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

extension View {
    /// Row metadata (`text-meta`): caption size in the given tier, muted by default.
    func meta(_ ink: Color = AceTheme.Colours.mutedForeground) -> some View {
        aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(ink).lineLimit(1)
    }
}
