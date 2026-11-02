import SwiftUI

/// Tool work reads quietly: a grey glyph in a fixed column and one muted line, about 30pt tall.
struct QuietRow<Content: View>: View {
    let icon: AceIcon.Name
    var tint: Color = AceTheme.Colours.decoration
    @ViewBuilder var content: () -> Content
    var body: some View {
        HStack(alignment: .center, spacing: AceDesign.Space.related) {
            AceIcon(icon, size: AceDesign.Size.icon, relativeTo: .subheadline).foregroundStyle(tint)
                .frame(width: AceDesign.Space.group)
            content()
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(AceDesign.Typeface.regular)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .frame(minHeight: AceDesign.Space.section, alignment: .leading)
    }
}

/// One step of the work log (the web's `StepRow`): glyph, verb, the target as a mono chip, the
/// diff stat and note at the right. A row with more to show opens in place to its output, diff
/// or failure; a browser, device or computer step opens its screen instead. A step waiting on an
/// approval steps aside: the request is the composer's.
struct StepRow: View {
    @Environment(\.openStep) private var openStep
    @Environment(\.aceReduceMotion) private var reduceMotion
    let step: StepLine
    /// The item it reads, which keeps its open state through regrouping.
    var id = ""
    var thread: ThreadModel? = nil
    /// Failed, then run again with success: neither failed nor noted.
    var retried = false
    @State private var localOpen = false
    var body: some View {
        if step.awaiting != true {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                BrowserStepLink(isBrowser: step.browser == true) { row }
                if open, let detail = step.detail {
                    StepDetailView(detail: detail).rowDetailIndent()
                        .onAppear { DisclosureTrace.shared.shown(key) }
                        .padding(.top, AceDesign.Space.tight).padding(.bottom, AceDesign.Space.related)
                }
            }
            .railMark(!step.settled ? .running : failed ? .failed : .done)
        }
    }
    private var failed: Bool { step.failed && !retried }
    private var expandable: Bool { step.expandable == true && step.detail != nil }
    private var key: String { "step:\(id)" }
    private var open: Bool { thread.map { $0.disclosures.isOpen(key) } ?? localOpen }
    @ViewBuilder private var row: some View {
        if let opens = step.opens, !opens.isEmpty, let openStep {
            Button { openStep(opens) } label: { line(open: nil) }.buttonStyle(.plain).accessibilityHint("Opens its screen")
        } else if expandable {
            Button {
                if !open { DisclosureTrace.shared.asked("step", key: key) }
                withAnimation(AceDesign.Motion.arriving(reduceMotion)) {
                    if let thread { thread.disclosures.toggle(key) } else { localOpen.toggle() }
                }
            } label: { line(open: open) }
            .buttonStyle(.plain)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
        } else {
            line(open: nil)
        }
    }
    private func line(open: Bool?) -> some View {
        LogRowBox(open: open) {
            StepGlyph(step: step, failed: failed)
        } title: {
            HStack(spacing: AceDesign.Space.related) {
                if !step.verb.isEmpty { Text(step.verb).layoutPriority(1) }
                if !step.target.isEmpty { TargetChip(target: step.target) }
            }
        } meta: {
            HStack(spacing: AceDesign.Space.tight) {
                if let added = step.added, let removed = step.removed, added > 0 || removed > 0 {
                    HStack(spacing: AceDesign.Space.tight) {
                        Text("+\(added)").foregroundStyle(AceTheme.StatusText.done)
                        Text("−\(removed)").foregroundStyle(AceTheme.StatusText.failed)
                    }
                    .aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                }
                if !step.note.isEmpty, !retried {
                    Text(step.note).foregroundStyle(failed ? AceTheme.StatusText.failed : AceTheme.Colours.subtleForeground)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel([step.verb, step.target, retried ? "" : step.note].filter { !$0.isEmpty }.joined(separator: " "))
        .accessibilityValue(step.settled ? "" : "Running")
        .accessibilityIdentifier(id.isEmpty ? "step" : "step.\(id)")
    }
}

/// A step's target as a mono chip. A path keeps its file name in view and gives way from its
/// folders when space runs short; a command or query truncates at its end.
struct TargetChip: View {
    let target: String
    var body: some View {
        let slash = target.lastIndex(of: "/")
        let path = slash.map { $0 > target.startIndex && target.index(after: $0) < target.endIndex } == true && !target.contains(" ")
        Group {
            if path, let slash {
                HStack(spacing: AceTheme.Spacing.none) {
                    Text(target[...slash]).truncationMode(.tail)
                    Text(target[target.index(after: slash)...]).layoutPriority(1)
                }
            } else {
                Text(target).truncationMode(.tail)
            }
        }
        .lineLimit(1)
        .aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
        .foregroundStyle(AceTheme.Colours.foreground)
        .padding(.horizontal, AceDesign.Space.related).padding(.vertical, AceTheme.Spacing.xxs)
        .background(AceTheme.Colours.fill, in: AceShape.capsule)
    }
}

/// What a step did, as its glyph (`@ace/ui-core` `stepGlyphKind`); a failed step's takes the
/// failure tone.
struct StepGlyph: View {
    let step: StepLine
    var failed: Bool
    var body: some View {
        Group {
            if step.glyph == "ace" {
                AceMark().frame(width: AceDesign.Size.glyphMeta, height: AceDesign.Size.glyphMeta)
            } else {
                AceIcon(Self.icon(step.glyph ?? step.icon), size: AceDesign.Size.icon, relativeTo: .subheadline)
            }
        }
        .foregroundStyle(failed ? AceTheme.StatusText.failed : AceTheme.Colours.subtleForeground)
    }
    static func icon(_ glyph: String) -> AceIcon.Name {
        switch glyph {
        case "device": .deviceMobile
        case "computer": .monitor
        case "browser": .compass
        case "think": .brain
        case "note": .note
        case "read": .fileText
        case "search": .magnifyingGlass
        case "list": .folderSimple
        case "command", "shell": .terminal
        case "edit": .notePencil
        case "web": .globe
        case "plan": .listChecks
        case "question": .chatCircle
        case "agent": .robot
        case "image": .image
        case "tool": .plug
        default: .wrench
        }
    }
}

/// An opened step: a command's output, each changed file as a compact diff, what a search
/// matched or a fetch read, a failure in words.
struct StepDetailView: View {
    let detail: StepDetail
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            if !detail.text.isEmpty {
                Text(detail.text).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(AceDesign.Typeface.regular)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).textSelection(.enabled)
            }
            if !detail.output.isEmpty {
                ScrollView {
                    Text((detail.outputTruncated ? "…\n" : "") + detail.output)
                        .aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(.horizontal, AceDesign.Space.row).padding(.vertical, AceDesign.Space.related)
                }
                .frame(maxHeight: AceDesign.Size.foldedOutput)
                .background(AceTheme.Colours.fill, in: AceShape.block)
                .accessibilityLabel("Output")
            }
            ForEach(Array(detail.diffs.enumerated()), id: \.offset) { _, diff in StepDiff(diff: diff) }
        }
    }
}

/// One file's change as a compact unified diff, scrolling sideways as code does.
private struct StepDiff: View {
    let diff: StepDetail.Diff
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            HStack(spacing: AceDesign.Space.related) {
                Text(diff.path).lineLimit(1).truncationMode(.head)
                if !diff.kind.isEmpty { Text(diff.kind).foregroundStyle(AceTheme.Colours.subtleForeground) }
            }
            .aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .frame(maxWidth: .infinity, minHeight: AceDesign.Space.section, alignment: .leading)
            .padding(.horizontal, AceDesign.Space.row)
            .overlay(alignment: .bottom) { Hairline() }
            ScrollView([.horizontal, .vertical]) {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    ForEach(Array(diff.lines.enumerated()), id: \.offset) { _, line in
                        HStack(spacing: AceTheme.Spacing.none) {
                            Text(Self.sign(line.kind)).frame(width: AceDesign.Space.margin, alignment: .leading)
                                .foregroundStyle(line.kind == "add" ? AceTheme.StatusText.done : line.kind == "del" ? AceTheme.StatusText.failed : .clear)
                            Text(line.text).foregroundStyle(line.kind == "hunk" ? AceTheme.Colours.subtleForeground : AceTheme.Colours.foreground)
                                .fixedSize()
                        }
                        .padding(.horizontal, AceDesign.Space.row)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(line.kind == "add" ? AceTheme.Colours.diffAdd : line.kind == "del" ? AceTheme.Colours.diffDelete : .clear)
                    }
                    if diff.more > 0 {
                        Text("\(diff.more) more lines").foregroundStyle(AceTheme.Colours.subtleForeground)
                            .padding(.horizontal, AceDesign.Space.row).padding(.top, AceDesign.Space.tight)
                    }
                }
                .aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                .padding(.vertical, AceDesign.Space.tight)
            }
            .frame(maxHeight: AceDesign.Size.foldedOutput)
        }
        .background(AceDesign.Surface.fill, in: AceShape.block)
        .clipShape(AceShape.block)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Diff of \(diff.path)")
    }
    static func sign(_ kind: String) -> String {
        switch kind {
        case "add": "+"
        case "del": "−"
        default: " "
        }
    }
}

/// A turn's work. While it runs, its steps stream in groups at the top of the turn under the
/// live "Working for" line; once the whole tree settles it folds into "Worked for 3m 12s" over a
/// hairline, and its steps open on a rail. A settled head that stays on screen a moment reads its
/// turn's steps ahead of a tap, and lets them go when it scrolls away; the bridge bounds how many
/// turns stay read.
struct WorkBlockView: View {
    @Environment(\.aceReduceMotion) private var reduceMotion
    let row: BlockRow
    let blockId: String
    let thread: ThreadModel
    var steps: StepsLinks? = nil
    var openMedia: ((TranscriptRow) -> Void)? = nil
    var openMessage: ((TranscriptRow) -> Void)? = nil
    /// Kept by the thread, so an opened log stays open on the way back from a child.
    private var expanded: Bool { thread.disclosures.isOpen(blockId) }
    var body: some View {
        if row.work?.ongoing == true {
            WorkLogRows(rows: row.log ?? [], source: source, live: true)
        } else {
            settled
        }
    }
    private var source: LogSource {
        LogSource(thread: thread, block: row, openMedia: openMedia, openMessage: openMessage)
    }
    private var settled: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            Button {
                if !expanded {
                    DisclosureTrace.shared.asked("steps", key: blockId)
                    holdSteps()
                }
                withAnimation(AceDesign.Motion.arriving(reduceMotion)) { thread.disclosures.toggle(blockId) }
            } label: {
                LogRowBox(open: expanded) { Text(row.work?.label ?? "Worked") }
            }
            .buttonStyle(.plain)
            .accessibilityLabel([row.work?.label ?? "Worked", row.work?.counts ?? ""].filter { !$0.isEmpty }.joined(separator: ", "))
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityHint(expanded ? "Hides the steps" : "Shows the steps")
            .accessibilityIdentifier("work.toggle")
            // Space, not a rule, sets the work apart from the answer (design language §3).
            Color.clear.frame(height: AceDesign.Space.tight).accessibilityHidden(true)
            if expanded {
                Group {
                    if let ordinal = row.ordinal, let steps {
                        DaemonSteps(ordinal: ordinal, blockId: blockId, links: steps, thread: thread, openMessage: openMessage)
                    } else if let log = row.log, !log.isEmpty {
                        StepRail { WorkLogRows(rows: log, source: source) }.onAppear { DisclosureTrace.shared.shown(blockId) }
                    } else {
                        Text("No steps recorded.").aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(AceDesign.Typeface.regular)
                            .foregroundStyle(AceTheme.Colours.subtleForeground).padding(.vertical, AceDesign.Space.tight)
                    }
                }
                .padding(.vertical, AceDesign.Space.tight)
            }
        }
        .task(id: row.ordinal) {
            // A head scrolled past quickly reads nothing; an opened log reads at once.
            if !expanded { try? await Task.sleep(for: .milliseconds(300)) }
            if !Task.isCancelled { holdSteps() }
        }
        .onDisappear {
            if let ordinal = row.ordinal, let steps { steps.model.closeSteps(ordinal: ordinal, epoch: steps.epoch) }
        }
    }
    private func holdSteps() {
        if let ordinal = row.ordinal, let steps { steps.model.openSteps(ordinal: ordinal, block: blockId) }
    }
}

extension View {
    /// What the agent says between steps stands apart from the step rows around it.
    func stepNarration(_ narration: Bool) -> some View {
        padding(.vertical, narration ? AceDesign.Space.tight : AceTheme.Spacing.none)
    }
}

extension EnvironmentValues {
    /// Opens what a step acted on (`StepLine.opens`): a device's or computer use's screen.
    @Entry var openStep: ((String) -> Void)? = nil
}
