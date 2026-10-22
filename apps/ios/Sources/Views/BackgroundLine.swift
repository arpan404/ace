import SwiftUI

/// A command the agent left running, where it started in the work log: "Running in background"
/// with Stop at the right, the command in mono under it with how long it has run. The line
/// changes when the daemon reports the task ended, not when Stop is pressed.
struct BackgroundLine: View {
    let line: BlockRow.Background
    @Environment(\.stopBackground) private var stopBackground
    @State private var stopping = false
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            HStack(spacing: AceTheme.Spacing.sm + AceTheme.Spacing.xxs) {
                AceIcon(.terminal, size: 16, relativeTo: .subheadline).foregroundStyle(AceTheme.Colours.subtleForeground)
                    .frame(minWidth: AceTheme.Spacing.xl).accessibilityHidden(true)
                Text(line.label).lineLimit(1)
                Spacer(minLength: AceTheme.Spacing.sm)
                if line.running, line.stoppable, let stopBackground {
                    Button {
                        stopping = true
                        stopBackground(line.taskId)
                    } label: {
                        AceIcon(.stop, size: 14, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                            .frame(width: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.md, height: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.md)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(stopping)
                    .accessibilityLabel(stopping ? "Stopping" : "Stop background command")
                    .accessibilityIdentifier("background.stop.\(line.taskId)")
                }
            }
            HStack(spacing: AceTheme.Spacing.sm) {
                Text(line.command).aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: AceTheme.Spacing.sm)
                age.aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.subtleForeground).monospacedDigit()
            }
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .frame(minHeight: AceTheme.Dimensions.touchTarget, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("background.\(line.taskId)")
    }
    @ViewBuilder private var age: some View {
        if line.running {
            TimelineView(.periodic(from: .now, by: 30)) { context in Text(Self.age(line.startedAt, context.date.timeIntervalSince1970 * 1000)) }
        } else if let ended = line.endedAt {
            Text(Self.age(line.startedAt, ended))
        }
    }
    /// "3m", "1h 4m", "40s": a command's age to the minute, as the web shows it.
    static func age(_ from: Double, _ to: Double) -> String {
        let seconds = Int((to - from) / 1000)
        guard seconds >= 0, seconds < 7 * 24 * 3600 else { return "" }
        if seconds < 60 { return "\(seconds)s" }
        return Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes], width: .narrow))
    }
}

/// Commands a log's calls left running, as a step of the log where they started: one task's
/// line, or several started back to back as one group ("2 background tasks · 1 running") whose
/// running lines stay in view, Stop and all; the ended ones open from the group. The rows
/// update in place as the tasks end; they never move.
struct BackgroundStep: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let row: BlockRow.LogRow
    let source: LogSource
    private var key: String { "group:\(row.id)" }
    var body: some View {
        let items = row.items ?? []
        let lines = items.compactMap { source.background[$0] }
        let running = Set(row.runningIds ?? [])
        Group {
            if items.count == 1, let line = lines.first {
                BackgroundLine(line: line)
            } else {
                let open = source.thread.disclosures.isOpen(key)
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    let listed = row.listed ?? []
                    if listed.isEmpty {
                        LogRowBox { AceIcon(.terminal, size: 16, relativeTo: .subheadline) } title: { Text(row.label ?? "") }
                    } else {
                        Button {
                            withAnimation(reduceMotion ? nil : AceTheme.Motion.standardCurve) { source.thread.disclosures.toggle(key) }
                        } label: {
                            LogRowBox(open: open) { AceIcon(.terminal, size: 16, relativeTo: .subheadline) } title: { Text(row.label ?? "") }
                        }
                        .buttonStyle(.plain)
                        .accessibilityValue(open ? "Expanded" : "Collapsed")
                        .accessibilityIdentifier("background.group.\(row.id)")
                    }
                    if open {
                        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                            ForEach(listed, id: \.self) { id in if let line = source.background[id] { BackgroundLine(line: line) } }
                        }
                        .rowDetailIndent()
                    }
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                        ForEach(items.filter { running.contains($0) }, id: \.self) { id in
                            if let line = source.background[id] { BackgroundLine(line: line) }
                        }
                    }
                    .rowDetailIndent()
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel(row.label ?? "")
            }
        }
        .railMark(lines.contains { $0.running } ? .running : lines.contains { $0.status == "failed" } ? .failed : .done)
    }
}

extension EnvironmentValues {
    /// Stops a background task by id; nil where the person can't act.
    @Entry var stopBackground: ((String) -> Void)? = nil
}
