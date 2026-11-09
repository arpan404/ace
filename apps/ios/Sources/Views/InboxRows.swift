import SwiftUI

/// One thread in the inbox, as the desktop row reads (`TaskLines`): the project's mark and name
/// with the pin and what an agent drives for it, and the status icon with its time at the right;
/// the title; then, where the thread has a branch or a pull request, the branch (mono, cut in the
/// middle), the pull request, the lines changed, running subagents, another machine and the
/// provider. Without either, those trailing marks end the title's line, so a row is three lines
/// only when it has something to say there. The state's meaning (`rowStatusLook`) leads the
/// row's spoken name.
struct InboxThreadRow: View {
    @Environment(\.aceDensityId) private var densityId
    let row: ThreadRow
    let snoozed: Bool
    var machine: MachineMark? = nil
    var project: ProjectMarkLook? = nil
    /// The request the row waits on, as one line under the title, while it needs the person.
    var need: InboxNeedLine? = nil
    @Environment(\.dynamicTypeSize) private var typeSize

    /// Old payloads without a look read quietly with the shared word.
    private var look: RowLook { Self.look(of: row) }
    static func look(of row: ThreadRow) -> RowLook {
        row.look ?? RowLook(level: "quiet", word: row.status.label, tone: row.status.token, muted: true,
                            glyph: nil, since: nil, settled: false, subagents: max(0, row.agents - 1))
    }
    /// The third line shows for a branch or a pull request, as the owner's row rule has it. A row
    /// that needs the person shows its request there instead, so every row stays three lines;
    /// the branch and pull request are a tap away in the thread.
    private var hasContext: Bool { need == nil && (!(row.branchLabel ?? row.branch).isEmpty || row.pr != nil) }

    var body: some View {
        let look = look
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            InboxRowHead(row: row, look: look, snoozed: snoozed, project: project)
            HStack(alignment: .center, spacing: AceDesign.Space.related) {
                Text(row.title)
                    .aceFont(InboxRowType.title, relativeTo: .callout)
                    // Semibold only while the thread needs the person, as on the desktop.
                    .fontWeight(look.strong == true ? AceDesign.Typeface.strong : AceDesign.Typeface.regular)
                    .foregroundStyle(look.settled ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground)
                    .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                Spacer(minLength: AceDesign.Space.related)
                // Without a last line the provider ends the title's.
                if !hasContext { InboxRowMarks(row: row, look: look, machine: machine).fixedSize() }
            }
            .frame(minHeight: AceDesign.Size.rowLine2)
            .padding(.top, AceDesign.Size.rowLineGap)
            if let need { need.padding(.top, AceDesign.Size.rowLastLineGap) }
            if hasContext {
                InboxRowContext(row: row, look: look, machine: machine).padding(.top, AceDesign.Size.rowLastLineGap)
            }
        }
        .padding(.horizontal, AceDesign.Size.rowInset)
        .padding(.top, InboxRowType.padding(densityId, AceDesign.Size.rowPaddingTop))
        .padding(.bottom, InboxRowType.padding(densityId, AceDesign.Size.rowPaddingBottom))
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        // What the icon means ("Needs approval"), the title, then the rest, as the desktop row
        // names itself.
        .accessibilityLabel(Self.spoken(row, look, snoozed: snoozed, need: need))
    }

    /// The row's spoken name, the same for its three lines and its one: the title, what the icon
    /// means ("Needs approval"), when a snoozed row wakes, then the rest.
    static func spoken(_ row: ThreadRow, _ look: RowLook, snoozed: Bool, need: InboxNeedLine?) -> String {
        let meaning = look.meaning ?? look.word
        let branch = row.branch.isEmpty ? nil : "Branch \(row.branch)"
        let pr = row.pr.map { "\($0.state) pull request #\($0.number)" }
        let work = row.work.map { "\($0.added) lines added, \($0.removed) lines removed" }
        // A snoozed row says when it wakes, as it shows it.
        let wake = snoozed && look.level != "needs-you" ? row.snoozedUntil.map(InboxRowLine.wake) : nil
        return [row.title, meaning, wake, need?.spoken, row.project.isEmpty ? nil : row.project, row.pinned == true ? "Pinned" : nil,
                row.browsing, row.computerUse, branch, pr, work]
            .compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: ", ")
    }
}

/// The row's first line: the project's mark and name, the pin, what an agent drives (browsing,
/// Mac apps), then at the right the status icon with its time, or when a snoozed row wakes.
struct InboxRowHead: View {
    let row: ThreadRow
    let look: RowLook
    let snoozed: Bool
    let project: ProjectMarkLook?
    var body: some View {
        HStack(alignment: .center, spacing: AceDesign.Space.tight) {
            // A project's own image or chosen glyph leads its name; none draws nothing.
            if project?.artwork != nil || project?.glyph != nil {
                ProjectMark(initials: "", chat: row.chat == true, look: project, quiet: look.settled)
            }
            Text(row.project).lineLimit(1)
            if row.pinned == true {
                AceIcon(.pushPin, size: AceDesign.Size.rowPin, relativeTo: .footnote)
            }
            // The web's marks: the globe with the agent's pointer in the working colour, and the
            // agent cursor itself, the Pebble, in the person's accent.
            if row.browsing != nil { BrowserUseMark().foregroundStyle(AceDesign.Status.working) }
            if row.computerUse != nil { PebbleMark() }
            Spacer(minLength: AceDesign.Space.related)
            if let wake = snoozed && look.level != "needs-you" ? row.snoozedUntil.map(InboxRowLine.wake) : nil {
                HStack(spacing: AceDesign.Space.tight) {
                    AceIcon(.clock, size: AceDesign.Size.rowPin, relativeTo: .caption)
                    Text(wake).lineLimit(1)
                }
                .aceFont(AceDesign.TextRole.time, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .fixedSize()
            } else {
                HStack(spacing: AceDesign.Space.tight) {
                    InboxRowMark(look: look, size: AceDesign.Size.rowStatusSymbol)
                    InboxRowAge(row: row, look: look)
                }
                .fixedSize()
            }
        }
        .frame(minHeight: AceDesign.Size.rowLine1)
        .aceFont(InboxRowType.line, relativeTo: .footnote)
        .foregroundStyle(AceTheme.Colours.subtleForeground)
    }
}

/// The row's third line, all in muted ink as the desktop's: the branch in mono, cut in the
/// middle; the pull request's glyph and number; the lines changed; then at the right running
/// subagents, another machine and the provider.
struct InboxRowContext: View {
    let row: ThreadRow
    let look: RowLook
    let machine: MachineMark?
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(alignment: .center, spacing: AceDesign.Space.tight + 2) {
            if let branch = row.branchLabel ?? (row.branch.isEmpty ? nil : row.branch) {
                Text(branch)
                    .foregroundStyle(AceDesign.Ink.branch(scheme))
                    .lineLimit(1).truncationMode(.middle)
                    .layoutPriority(-1)
            }
            if let pr = row.pr {
                HStack(spacing: AceTheme.Spacing.xxs) {
                    AceIcon(pr.state == "merged" ? .gitMerge : .gitPullRequest, size: AceDesign.Size.rowGlyph11, relativeTo: .caption2)
                    Text(verbatim: "#\(pr.number)")
                    if let more = row.prs?.count, more > 1 { Text(verbatim: "+\(more - 1)") }
                }
                .fixedSize()
            }
            if let work = row.work { InboxRowWork(work: work).fixedSize() }
            Spacer(minLength: AceDesign.Space.related)
            InboxRowMarks(row: row, look: look, machine: machine).fixedSize()
        }
        .aceMonospace(AceDesign.TextRole.branch, relativeTo: .caption2)
        .foregroundStyle(AceTheme.Colours.subtleForeground)
        .frame(minHeight: AceDesign.Size.rowLine3)
    }
}

/// Lines changed, "+120 −8", in the diff's colours.
struct InboxRowWork: View {
    let work: ThreadRow.Work
    var body: some View {
        HStack(spacing: AceDesign.Space.tight) {
            // The status text inks, as the desktop's `text-status-done` and `text-status-failed`.
            Text(verbatim: "+\(work.added)").foregroundStyle(AceDesign.Ink.added)
            Text(verbatim: "−\(work.removed)").foregroundStyle(AceDesign.Ink.removed)
        }
        .monospacedDigit()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(work.added) lines added, \(work.removed) lines removed")
    }
}

/// The row's type: the title role for the thread's title and the body role for the line under
/// it (design language §3), as the system's lists set them.
@MainActor enum InboxRowType {
    static let title = AceDesign.TextRole.rowTitle
    static let line = AceDesign.TextRole.meta
    /// Above or below a row's lines: the phone's row padding, or less where the density is
    /// compact.
    static func padding(_ density: String, _ wanted: CGFloat = AceDesign.Size.rowPaddingTop) -> CGFloat {
        min(AceTheme.density(density).inboxRowPadding, wanted)
    }
}

/// The one status mark beside a row: the desktop row's status icon in its state's colour
/// (`RowStatusIcon`), nothing for a thread at rest. Older bridges without the icon draw a dot for
/// needs-you or failed and a turning ring for live work. Decorative; the line under the title
/// says it in words.
struct InboxRowMark: View {
    let look: RowLook
    var size: CGFloat = AceDesign.Size.icon
    /// Sits the mark's centre on the title's first line rather than on its baseline.
    nonisolated static let baseline: CGFloat = 4
    var body: some View {
        if let icon = look.icon {
            Group {
                if icon == "none" { Color.clear } else { RowStatusIcon(kind: icon, tone: look.iconTone ?? "idle", count: look.count, size: size) }
            }
            .frame(width: size + 2)
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
            .aceFont(AceDesign.TextRole.time, relativeTo: .caption)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
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
            Spacer(minLength: AceTheme.Spacing.none)
        }
        .aceFont(InboxRowType.line, relativeTo: .footnote)
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
                    AceIcon(.treeStructure, size: AceDesign.Size.glyphSmall, relativeTo: .footnote)
                    Text(look.subagents.formatted()).monospacedDigit()
                }
                .aceFont(InboxRowType.line, relativeTo: .footnote)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(look.subagents) agents")
            }
            // The provider in its own colours at 80% (a one-colour mark in the foreground ink).
            ProviderMark(provider: row.provider, size: AceDesign.Size.rowMark, account: row.account, quiet: look.settled)
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
                Text(entry.text).aceFont(InboxRowType.title, relativeTo: .callout)
                    .foregroundStyle(AceTheme.Colours.foreground).lineLimit(2)
                (Text(entry.label ?? "").foregroundStyle(tone == .needsYou ? tone.text : AceTheme.Colours.mutedForeground)
                 + Text(thread.map { " · \($0.title)" } ?? "").foregroundStyle(AceTheme.Colours.mutedForeground))
                    .aceFont(InboxRowType.line, relativeTo: .footnote).lineLimit(1)
            }
        }
        .padding(.horizontal, AceTheme.Spacing.rowInner)
        .padding(.vertical, InboxRowType.padding(densityId))
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
