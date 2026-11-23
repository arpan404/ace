import SwiftUI

/// A command step's one row, whether it runs or ran, in the foreground or the background: what it
/// does in words, its time at the right, a chevron. The raw command is behind a tap, in `CommandSheet`.
struct CommandTitle: View {
    let label: String
    var background = false
    var body: some View {
        HStack(spacing: AceDesign.Space.related) {
            Text(label).truncationMode(.tail).layoutPriority(1)
            if background {
                Text("background").aceFont(AceDesign.TextRole.time)
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
            }
        }
    }
}

/// The full command in mono, wrapping and selectable, over its output. A failure says its exit code.
struct CommandSheet: View {
    let command: String
    var output = ""
    var outputTruncated = false
    var exitCode: Int? = nil
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                    if let exitCode, exitCode != 0 {
                        Text("Exit code \(exitCode)").aceFont(AceDesign.TextRole.meta)
                            .foregroundStyle(AceTheme.StatusText.failed)
                    }
                    Text(command).aceMonospace(AceDesign.TextRole.code)
                        .foregroundStyle(AceTheme.Colours.foreground)
                        .textSelection(.enabled)
                        .accessibilityLabel("Command")
                    if !output.isEmpty {
                        Text((outputTruncated ? "…\n" : "") + output)
                            .aceMonospace(AceDesign.TextRole.code)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                            .textSelection(.enabled)
                            .accessibilityLabel("Output")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(AceDesign.Space.margin)
            }
            .navigationTitle("Command").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Copy", ace: .copy) { UIPasteboard.general.string = command } }
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

extension StepLine.Command {
    /// "9s", "1m 34s": how long it ran; nil while it runs.
    var duration: String? {
        durationMs.map { ActivityTime.running(since: Date(timeIntervalSince1970: 0), now: Date(timeIntervalSince1970: $0 / 1000)) }
    }
    /// "Ran: Wait for build, finished in 9 seconds"; a failure says so.
    func spoken(running: Bool, failed: Bool) -> String {
        if running { return "Running: \(label)" }
        let seconds = durationMs.map { Int(($0 / 1000).rounded()) }
        if failed { return "Failed: \(label)" + (seconds.map { ", after \($0) seconds" } ?? "") }
        return "Ran: \(label)" + (seconds.map { ", finished in \($0) seconds" } ?? "")
    }
}
