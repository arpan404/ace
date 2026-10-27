import SwiftUI

/// One thread in the inbox: two lines beside one small status mark. The title and its age, then
/// the project's mark and name and what the thread wants or is doing, with the machine (only
/// when several are paired), running subagents and the provider at the end. Only a thread that
/// needs the person, or failed, takes colour. Branch and pull request live in the thread itself.
struct InboxThreadRow: View {
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
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.md) {
            InboxRowMark(look: look).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
                    Text(row.title)
                        .aceFont(InboxRowType.title, relativeTo: .body)
                        .foregroundStyle(look.settled ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground)
                        .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                    Spacer(minLength: AceTheme.Spacing.sm)
                    InboxRowAge(row: row, look: look)
                }
                InboxRowLine(row: row, look: look, snoozed: snoozed, machine: machine, project: project)
            }
        }
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.vertical, AceTheme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// The row's type: a regular 17pt title and a 15pt line under it, as the system's lists set them.
enum InboxRowType {
    static let title = AceTheme.TypeStyle(size: 17, lineHeight: 22, weight: 400, tracking: -0.2)
    static let line = AceTheme.TypeStyle(size: 15, lineHeight: 20, weight: 400, tracking: -0.1)
}

/// The one status mark beside a row: a dot for needs-you or failed, a still open ring for live
/// work, nothing for a thread at rest. Decorative; the line under the title says it in words.
struct InboxRowMark: View {
    let look: RowLook
    var body: some View {
        let tone = AceTone(look.tone)
        Group {
            switch look.level {
            case _ where look.level == "needs-you" || tone == .failed: Circle().fill(tone.mark).frame(width: 8, height: 8)
            case "active": Circle().trim(from: 0.12, to: 0.88).stroke(AceTheme.Colours.mutedForeground, lineWidth: 1.6)
                .rotationEffect(.degrees(-90)).frame(width: 9, height: 9)
            default: Color.clear.frame(width: 8, height: 8)
            }
        }
        .frame(width: 10)
        .accessibilityHidden(true)
    }
}

/// The age on the title's line: how long live work has run, else how long since it moved.
struct InboxRowAge: View {
    let row: ThreadRow
    let look: RowLook
    var body: some View {
        TimelineView(.everyMinute) { context in
            Text(text(at: context.date)).monospacedDigit()
                .aceFont(InboxRowType.line, relativeTo: .subheadline)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
                .lineLimit(1).fixedSize()
        }
    }
    private func text(at now: Date) -> String {
        if look.level == "active", let start = look.since ?? row.activityAt,
           let elapsed = ActivityTime.elapsed(since: Date(timeIntervalSince1970: start / 1000), now: now) {
            return elapsed
        }
        return ActivityTime.age(since: Date(timeIntervalSince1970: (row.activityAt ?? row.updatedAt) / 1000), now: now)
    }
}

/// The line under the title: the project's mark and name, then the status word (in colour only
/// when the thread needs the person or failed). At the end, never wrapping: the machine's mark,
/// running subagents and the provider's mark. When space runs short the project name gives way
/// first.
struct InboxRowLine: View {
    let row: ThreadRow
    let look: RowLook
    let snoozed: Bool
    let machine: MachineMark?
    let project: ProjectMarkLook?
    var body: some View {
        let word = snoozed && !look.loud ? row.snoozedUntil.map(Self.wake) : look.word
        let loud = look.level == "needs-you" || AceTone(look.tone) == .failed
        let named = !row.project.isEmpty
        HStack(alignment: .center, spacing: AceTheme.Spacing.xs) {
            if named {
                ProjectMark(initials: row.badge ?? "", chat: row.chat == true, look: project, quiet: look.settled)
                Text(row.project).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
            }
            if let word {
                Text((named ? "· " : "") + word)
                    .fontWeight(loud ? .medium : .regular)
                    .foregroundStyle(loud ? AceTone(look.tone).text : AceTheme.Colours.mutedForeground)
                    .lineLimit(1)
                    .layoutPriority(1)
            }
            Spacer(minLength: AceTheme.Spacing.sm)
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
/// icon, then the provider with its account bubble. Settled rows grey them with the rest.
struct InboxRowMarks: View {
    let row: ThreadRow
    let look: RowLook
    let machine: MachineMark?
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            if let machine {
                AceIcon(machine.glyph, size: 14, relativeTo: .subheadline)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(machine.name)
            }
            if look.subagents > 0 {
                HStack(spacing: AceTheme.Spacing.xxs) {
                    AceIcon(.treeStructure, size: 12, relativeTo: .subheadline)
                    Text(look.subagents.formatted()).monospacedDigit()
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(look.subagents) agents")
            }
            ProviderMark(provider: row.provider, size: 15, account: row.account, quiet: look.settled)
        }
        .foregroundStyle(look.settled ? AceTheme.Colours.faintForeground : AceTheme.Colours.subtleForeground)
    }
}

/// A send the SDK still holds, drawn like a thread row: its text, then the shared unsent
/// wording and the thread it goes to. A send that failed takes the needs-you dot.
struct InboxUnsentRow: View {
    let entry: PendingRow
    let thread: ThreadRow?
    var body: some View {
        let tone = AceTone(entry.token ?? "neutral")
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.md) {
            Group {
                if tone == .needsYou { Circle().fill(tone.mark).frame(width: 8, height: 8) } else { Color.clear.frame(width: 8, height: 8) }
            }
            .frame(width: 10).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(entry.text).aceFont(InboxRowType.title, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.foreground).lineLimit(2)
                (Text(entry.label ?? "").foregroundStyle(tone == .needsYou ? tone.text : AceTheme.Colours.mutedForeground)
                 + Text(thread.map { " · \($0.title)" } ?? "").foregroundStyle(AceTheme.Colours.mutedForeground))
                    .aceFont(InboxRowType.line, relativeTo: .subheadline).lineLimit(1)
            }
        }
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.vertical, AceTheme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// "Snoozed 2 ›": a folded group at the end of the list, quiet until opened.
struct InboxShelf: View {
    let label: String
    let count: Int
    let expanded: Bool
    let toggle: () -> Void
    var body: some View {
        Button(action: toggle) {
            HStack(spacing: AceTheme.Spacing.xs) {
                Text(label).fontWeight(.medium)
                Text(count.formatted()).monospacedDigit().foregroundStyle(AceTheme.Colours.subtleForeground)
                AceIcon(.caretRight, size: 12, weight: .bold, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.faintForeground)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                Spacer(minLength: AceTheme.Spacing.none)
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .padding(.horizontal, AceTheme.Spacing.md)
            .frame(minHeight: 40)
        }
        .buttonStyle(.row)
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
    }
}

extension View {
    /// Row metadata (`text-meta`): caption size in the given tier, muted by default.
    func meta(_ ink: Color = AceTheme.Colours.mutedForeground) -> some View {
        aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(ink).lineLimit(1)
    }
}
