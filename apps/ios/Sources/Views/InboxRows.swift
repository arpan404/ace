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
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.md) {
            InboxRowMark(look: look).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            VStack(alignment: .leading, spacing: AceTheme.density(densityId).inboxLineGap) {
                HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
                    Text(row.title)
                        .aceFont(InboxRowType.title, relativeTo: .body)
                        // Semibold only while the thread needs the person, as on the desktop.
                        .fontWeight(look.strong == true ? .semibold : .regular)
                        .foregroundStyle(look.settled ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground)
                        .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                    Spacer(minLength: AceTheme.Spacing.sm)
                    InboxRowAge(row: row, look: look)
                }
                InboxRowLine(row: row, look: look, snoozed: snoozed, machine: machine, project: project)
            }
        }
        .padding(.horizontal, AceTheme.Spacing.md)
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

/// The row's type: a regular 17pt title and a 15pt line under it, as the system's lists set them.
enum InboxRowType {
    static let title = AceTheme.TypeStyle(size: 17, lineHeight: 22, weight: 400, tracking: -0.2)
    static let line = AceTheme.TypeStyle(size: 15, lineHeight: 20, weight: 400, tracking: -0.1)
}

/// The one status mark beside a row: the desktop row's status icon in its state's colour
/// (`RowStatusIcon`), nothing for a thread at rest. Older bridges without the icon draw a dot for
/// needs-you or failed and a turning ring for live work. Decorative; the line under the title
/// says it in words.
struct InboxRowMark: View {
    let look: RowLook
    var body: some View {
        if let icon = look.icon {
            Group {
                if icon == "none" { Color.clear } else { RowStatusIcon(kind: icon, tone: look.iconTone ?? "idle", count: look.count) }
            }
            .frame(width: 18)
            .accessibilityHidden(true)
        } else {
            legacy
        }
    }
    private var legacy: some View {
        let tone = AceTone(look.tone)
        return Group {
            switch look.level {
            case _ where look.level == "needs-you" || tone == .failed: Circle().fill(tone.mark).frame(width: 8, height: 8)
            case "active": InboxWorkingRing()
            default: Color.clear.frame(width: 8, height: 8)
            }
        }
        .frame(width: 10)
        .accessibilityHidden(true)
    }
}

/// Animate only the mark, leaving the row's layout and text untouched. Stop offscreen, while
/// the app is inactive, and for Reduce Motion.
private struct InboxWorkingRing: View {
    @Environment(\.aceReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var visible = false
    @State private var turning = false
    private var moving: Bool { visible && !reduceMotion && scenePhase == .active }

    var body: some View {
        Circle().trim(from: 0.12, to: 0.88)
            .stroke(AceTheme.Colours.mutedForeground, lineWidth: 1.6)
            .rotationEffect(.degrees(turning ? 270 : -90))
            .frame(width: 9, height: 9)
            .animation(moving ? .linear(duration: AceTheme.Motion.statusPulse).repeatForever(autoreverses: false) : nil, value: turning)
            .onAppear { visible = true }
            .onDisappear { visible = false }
            .onChange(of: moving) { _, now in turning = now }
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
        HStack(alignment: .center, spacing: AceTheme.Spacing.xs) {
            if named {
                Text(row.project).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
            }
            if let word {
                Text((named ? "· " : "") + word)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
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
            // The provider in its own colours at 80% (a one-colour mark in the foreground ink).
            ProviderMark(provider: row.provider, size: 15, account: row.account, quiet: look.settled)
                .foregroundStyle(look.settled ? AceTheme.Colours.faintForeground : AceTheme.Colours.foreground)
                .opacity(look.settled ? 1 : 0.8)
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
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.md) {
            Group {
                if tone == .needsYou { Circle().fill(tone.mark).frame(width: 8, height: 8) } else { Color.clear.frame(width: 8, height: 8) }
            }
            .frame(width: 10).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: AceTheme.density(densityId).inboxLineGap) {
                Text(entry.text).aceFont(InboxRowType.title, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.foreground).lineLimit(2)
                (Text(entry.label ?? "").foregroundStyle(tone == .needsYou ? tone.text : AceTheme.Colours.mutedForeground)
                 + Text(thread.map { " · \($0.title)" } ?? "").foregroundStyle(AceTheme.Colours.mutedForeground))
                    .aceFont(InboxRowType.line, relativeTo: .subheadline).lineLimit(1)
            }
        }
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.vertical, AceTheme.density(densityId).inboxRowPadding)
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
