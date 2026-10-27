import SwiftUI

/// Where a work log's rows read their steps: the live thread's items (each observed alone, so
/// streaming re-renders its own row), else the steps a finished turn's log read from the daemon;
/// and what the log as a whole decided about them (`bridge/work-log.ts`).
@MainActor struct LogSource {
    let thread: ThreadModel
    var fetched: [String: TranscriptRow] = [:]
    var ace: [String: StepLine] = [:]
    var background: [String: BlockRow.Background] = [:]
    var retried: Set<String> = []
    var thoughts: [String: BlockRow.Thought] = [:]
    var openMedia: ((TranscriptRow) -> Void)? = nil
    var openMessage: ((TranscriptRow) -> Void)? = nil

    init(thread: ThreadModel, block: BlockRow, openMedia: ((TranscriptRow) -> Void)? = nil, openMessage: ((TranscriptRow) -> Void)? = nil) {
        self.init(thread: thread, ace: block.aceSteps, background: block.background, retried: block.retried, thoughts: block.thoughts, openMedia: openMedia, openMessage: openMessage)
    }
    init(thread: ThreadModel, fetched: [String: TranscriptRow] = [:], ace: [BlockRow.AceStep]?, background: [BlockRow.Background]?,
         retried: [String]?, thoughts: [BlockRow.Thought]?, openMedia: ((TranscriptRow) -> Void)? = nil, openMessage: ((TranscriptRow) -> Void)? = nil) {
        self.thread = thread
        self.fetched = fetched
        self.ace = Dictionary((ace ?? []).map { ($0.id, $0.step) }, uniquingKeysWith: { $1 })
        self.background = Dictionary((background ?? []).map { ($0.itemId, $0) }, uniquingKeysWith: { $1 })
        self.retried = Set(retried ?? [])
        self.thoughts = Dictionary((thoughts ?? []).map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        self.openMedia = openMedia
        self.openMessage = openMessage
    }
}

/// A work log as one quiet flow (the web's `GroupedSteps`): consecutive steps as one sentence
/// row with a muted icon ("Edited 2 files and ran 1 command"), opening in place to their steps on
/// a rail; a lone step as its own row; what the agent said between steps as prose. While the turn
/// works its last group shows its step in flight as its title.
struct WorkLogRows: View {
    let rows: [BlockRow.LogRow]
    let source: LogSource
    /// The turn still works: its last group keeps the step in flight in view.
    var live = false
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            ForEach(rows) { row in
                LogRowView(row: row, source: source, live: live && row.id == rows.last?.id)
            }
        }
    }
}

private struct LogRowView: View {
    let row: BlockRow.LogRow
    let source: LogSource
    let live: Bool
    var body: some View {
        switch row.kind {
        case "group": LogGroupView(row: row, source: source, live: live)
        case "thought": LogStep(id: row.id, source: source)
        case "background": BackgroundStep(row: row, source: source)
        default: LogStep(id: row.id, source: source)
        }
    }
}

/// One step of a log by id: the live item when the thread holds it, else the daemon's copy.
struct LogStep: View {
    let id: String
    let source: LogSource
    var body: some View {
        if let item = source.thread.items[id] {
            LiveLogStep(item: item, source: source)
        } else if let row = source.fetched[id] {
            LogStepContent(row: row, source: source)
        }
    }
}

private struct LiveLogStep: View {
    @Bindable var item: ItemModel
    let source: LogSource
    var body: some View { LogStepContent(row: item.row, source: source) }
}

private struct LogStepContent: View {
    let row: TranscriptRow
    let source: LogSource
    var body: some View {
        switch row.type {
        case "message":
            MarkdownView(text: row.text).stepNarration(true)
        case "reasoning":
            ReasoningRow(row: row, thought: source.thoughts[row.id], thread: source.thread, openMessage: source.openMessage)
        case "html", "image":
            if let openMedia = source.openMedia { PublishedMediaRow(row: row) { openMedia(row) } }
            else { VisualizationRow(row: row) }
        default:
            if let step = source.ace[row.id] ?? row.step {
                StepRow(step: step, id: row.id, thread: source.thread, retried: source.retried.contains(row.id))
            } else {
                Text(row.text).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
        }
    }
}

/// Consecutive steps as one row: its icon and sentence ("Ran 3 commands · 1 failed"), or while
/// the turn works the step in flight ("Running `bun run slow` · 2 steps"). It opens in place to
/// its steps on a rail, and stays open while it holds a step the reader opened. A long group lays
/// out its first rows in the frame it opens and the rest just after, so the tap answers at once.
private struct LogGroupView: View {
    @Environment(\.aceReduceMotion) private var reduceMotion
    let row: BlockRow.LogRow
    let source: LogSource
    let live: Bool
    /// About a screen of steps.
    private static let firstRows = 16
    @State private var shown = firstRows
    private var key: String { "group:\(row.id)" }
    private var disclosures: Disclosures { source.thread.disclosures }
    private var open: Bool {
        disclosures.chosen(key) ?? (row.items ?? []).contains { disclosures.isOpen("step:\($0)") }
    }
    var body: some View {
        let running = row.running == true
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            Button {
                if !open { DisclosureTrace.shared.asked("group", key: key) }
                withAnimation(reduceMotion ? nil : AceTheme.Motion.standardCurve) { disclosures.set(key, open: !open) }
            } label: {
                if live && running, let active = row.active, let item = source.thread.items[active] {
                    LiveGroupTitle(item: item, step: source.ace[active], count: row.count ?? "", open: open)
                } else {
                    LogRowBox(open: open) {
                        AceIcon(Self.icon(row.icon ?? ""), size: 16, relativeTo: .subheadline)
                    } title: {
                        (Text(row.sentence ?? "") + failedText).shimmer(running && live)
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(row.summary ?? row.sentence ?? "")
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            .accessibilityIdentifier("work.group.\(row.id)")
            if open {
                let items = row.items ?? []
                StepRail { ForEach(items.prefix(shown), id: \.self) { LogStep(id: $0, source: source) } }
                    .onAppear { DisclosureTrace.shared.shown(key) }
                    .task {
                        // The next turn of the run loop, after the opening frame is committed.
                        if items.count > shown { try? await Task.sleep(for: .milliseconds(1)) }
                        if !Task.isCancelled { shown = .max }
                    }
                    .onDisappear { shown = Self.firstRows }
            }
        }
        .railMark(running ? .running : (row.failed ?? 0) > 0 ? .failed : .done)
    }
    private var failedText: Text {
        guard let failed = row.failed, failed > 0 else { return Text("") }
        return Text(" · \(failed) failed").foregroundStyle(AceTheme.StatusText.failed)
    }
    static func icon(_ icon: String) -> AceIcon.Name {
        switch icon {
        case "explore", "search": .magnifyingGlass
        case "mixed": .hammer
        case "edit": .notePencil
        case "command", "background": .terminal
        case "computer": .monitor
        case "browser": .compass
        case "fetch", "websearch": .globe
        case "read": .fileText
        case "list": .folderSimple
        case "plan": .listChecks
        case "spawn", "agent": .robot
        case "question": .chatTeardropText
        case "think": .brain
        default: .plug
        }
    }
}

/// A running group's title: its step in flight and how many steps it holds, or the approval it
/// waits on.
private struct LiveGroupTitle: View {
    @Bindable var item: ItemModel
    /// ace's own wording of the step, when the log has one.
    let step: StepLine?
    let count: String
    let open: Bool
    var body: some View {
        if let step = step ?? item.row.step {
            LogRowBox(open: open) {
                StepGlyph(step: step, failed: false)
            } title: {
                if step.awaiting == true {
                    Text("Waiting for your approval")
                } else {
                    HStack(spacing: AceTheme.Spacing.none) {
                        Text([step.verb, step.target].filter { !$0.isEmpty }.joined(separator: " "))
                            .truncationMode(.middle).shimmer(!step.settled)
                        if !count.isEmpty {
                            Text(" · \(count)").foregroundStyle(AceTheme.Colours.subtleForeground).layoutPriority(1)
                        }
                    }
                }
            }
        } else if item.row.type == "reasoning" {
            LogRowBox(open: open) { AceIcon(.brain, size: 16, relativeTo: .subheadline) } title: { Text("Thinking…").shimmer(true) }
        } else {
            LogRowBox(open: open) { AceIcon(.hammer, size: 16, relativeTo: .subheadline) } title: { Text("Working").shimmer(true) }
        }
    }
}
