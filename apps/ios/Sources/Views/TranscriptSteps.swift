import SwiftUI

/// Tool work reads quietly: a grey glyph in a fixed column and one muted line, about 30pt tall.
struct QuietRow<Content: View>: View {
    let icon: AceIcon.Name
    var tint: Color = AceTheme.Colours.decoration
    @ViewBuilder var content: () -> Content
    var body: some View {
        HStack(alignment: .center, spacing: AceTheme.Spacing.sm + AceTheme.Spacing.xxs) {
            AceIcon(icon, size: 16, relativeTo: .subheadline).foregroundStyle(tint)
                .frame(width: AceTheme.Spacing.xxl)
            content()
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .frame(minHeight: AceTheme.Spacing.xxxl, alignment: .leading)
    }
}

/// A step's line: "Read process-owner.ts", "Edited src/boot.ts +18 −6". A running step shimmers.
struct StepRow: View {
    @Environment(\.openStep) private var openStep
    let step: StepLine
    var body: some View {
        // An agent's browser step opens the thread's browser; device and computer steps open their screens.
        BrowserStepLink(isBrowser: step.browser == true) { row }
    }
    @ViewBuilder private var row: some View {
        if let opens = step.opens, !opens.isEmpty, let openStep {
            Button { openStep(opens) } label: { line }.buttonStyle(.plain).accessibilityHint("Opens its screen")
        } else {
            line
        }
    }
    private var line: some View {
        QuietRow(icon: Self.symbol(step.icon), tint: step.failed ? AceTheme.Status.failed : step.needsYou ? AceTheme.Status.needsYou : AceTheme.Colours.decoration) {
            HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
                if !step.verb.isEmpty { Text(step.verb).layoutPriority(1) }
                if !step.target.isEmpty {
                    Text(step.target).aceMonospace(AceTheme.Typography.code, relativeTo: .footnote).lineLimit(1).truncationMode(.middle)
                }
                if let added = step.added, let removed = step.removed {
                    Text("+\(added)").foregroundStyle(AceTheme.StatusText.done).monospacedDigit().layoutPriority(1)
                    Text("−\(removed)").foregroundStyle(AceTheme.StatusText.failed).monospacedDigit().layoutPriority(1)
                }
            }
            .lineLimit(1)
            .shimmer(!step.settled)
            Spacer(minLength: AceTheme.Spacing.none)
            if !step.note.isEmpty {
                Text(step.note).foregroundStyle(step.failed ? AceTheme.StatusText.failed : AceTheme.Colours.subtleForeground).lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(step.settled ? "" : "Running")
    }
    static func symbol(_ icon: String) -> AceIcon.Name {
        switch icon {
        case "read": .fileText
        case "search", "explore": .magnifyingGlass
        case "list": .listBullets
        case "shell", "command": .terminalWindow
        case "edit": .notePencil
        case "web", "fetch", "websearch": .globe
        case "browser": .compass
        case "computer": .monitor
        case "device": .deviceMobile
        case "plan": .listChecks
        case "think": .brain
        case "note": .info
        default: .wrench
        }
    }
}

/// A turn's work. While it runs, its grouped steps show in place under the live "Working for"
/// line; once it settles it folds to "Worked for 3m 12s ›" over a hairline.
struct WorkBlockView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let row: BlockRow
    var blockId = ""
    let thread: ThreadModel
    var steps: StepsLinks? = nil
    var openMessage: ((TranscriptRow) -> Void)? = nil
    @State private var expanded = false
    var body: some View {
        if row.work?.ongoing == true, let groups = row.groups {
            WorkProgressView(groups: groups, thread: thread, background: row.background ?? [], openMessage: openMessage)
        } else {
            settled
        }
    }
    private var settled: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            Button { withAnimation(reduceMotion ? nil : AceTheme.Motion.standardCurve) { expanded.toggle() } } label: {
                HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
                    Text(row.work?.label ?? "Worked").lineLimit(1)
                    AceIcon(.caretRight, size: 12, relativeTo: .caption)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .foregroundStyle(AceTheme.Colours.subtleForeground)
                    Spacer(minLength: AceTheme.Spacing.sm)
                    if let failed = row.work?.failed, failed > 0 {
                        Text("\(failed) failed").foregroundStyle(AceTheme.StatusText.failed).monospacedDigit()
                    }
                }
                .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm)
                .contentShape(Rectangle())
                .overlay(alignment: .bottom) {
                    Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel([row.work?.label ?? "Worked", row.work?.counts ?? ""].filter { !$0.isEmpty }.joined(separator: ", "))
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityHint(expanded ? "Hides the steps" : "Shows the steps")
            .accessibilityIdentifier("work.toggle")
            if expanded {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    if let ordinal = row.ordinal, let steps {
                        DaemonSteps(ordinal: ordinal, blockId: blockId, links: steps)
                    } else if let groups = row.groups, !groups.isEmpty {
                        WorkProgressView(groups: groups, thread: thread, background: row.background ?? [], openMessage: openMessage)
                    } else {
                        ForEach(row.items, id: \.self) { id in
                            if let item = thread.items[id] { WorkStep(item: item) }
                        }
                        if row.items.isEmpty { Text("No steps recorded.").aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.subtleForeground) }
                    }
                }
                .padding(.top, AceTheme.Spacing.xs)
            }
        }
    }
}

/// A step inside an opened log, or what the agent said between steps.
private struct WorkStep: View {
    @Bindable var item: ItemModel
    var body: some View {
        if item.row.type == "message" {
            MarkdownView(text: item.row.text)
        } else { ItemRowView(item: item, workEnded: true) }
    }
}

/// A light sweep across live text. Off with Reduce Motion, where the text simply stays put.
private struct Shimmer: ViewModifier {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        if active && !reduceMotion {
            content.overlay {
                TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                    let period = AceTheme.Motion.statusPulse
                    let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period
                    GeometryReader { geometry in
                        LinearGradient(colors: [.clear, AceTheme.Colours.foreground, .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: geometry.size.width * 0.5)
                            .offset(x: (phase * 1.5 - 0.5) * geometry.size.width)
                    }
                }
                .mask(content)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        } else {
            content
        }
    }
}

extension View {
    func shimmer(_ active: Bool) -> some View { modifier(Shimmer(active: active)) }
}

extension EnvironmentValues {
    /// Opens what a step acted on (`StepLine.opens`): a device's or computer use's screen.
    @Entry var openStep: ((String) -> Void)? = nil
}
