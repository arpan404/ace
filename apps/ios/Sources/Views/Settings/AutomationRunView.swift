import SwiftUI

/// One run: when it started and how it went, what it said, and the way into its thread.
struct AutomationRunView: View {
    @Environment(\.aceReduceMotion) private var reduceMotion
    let run: AutomationRunRow
    let canRun: Bool
    let open: (() -> Void)?
    let runAgain: () -> Void
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            HStack(spacing: AceDesign.Space.tight) {
                if let head = run.head { StateLabel(status: head.status) }
                Text([run.when, run.detail].compactMap { $0 }.joined(separator: " · "))
                    .foregroundStyle(AceDesign.Ink.muted).monospacedDigit()
            }
            .font(AceDesign.Typeface.meta)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("automation.run.\(run.id)")
            if run.live {
                (Text("Working for ") + Text(Date(timeIntervalSince1970: run.startedAt / 1000), style: .timer))
                    .font(AceDesign.Typeface.title)
                    .foregroundStyle(AceDesign.Ink.muted).monospacedDigit()
            } else if let note = run.note {
                Text(note).font(AceDesign.Typeface.title)
                    .foregroundStyle(AceDesign.Ink.muted)
            }
            if let body = run.body {
                Text(body).font(AceDesign.Typeface.title)
                    .foregroundStyle(run.muted ? AceDesign.Ink.muted : AceDesign.Ink.primary)
                    .lineLimit(expanded ? nil : 4)
                    .textSelection(.enabled)
            }
            HStack(spacing: AceDesign.Space.margin) {
                if let open {
                    Button("Open thread", action: open).accessibilityIdentifier("automation.run.open.\(run.id)")
                }
                if run.runAgain {
                    Button("Run again", action: runAgain).disabled(!canRun)
                        .accessibilityIdentifier("automation.run.again.\(run.id)")
                }
                if (run.body?.count ?? 0) > 220 {
                    Button(expanded ? "Show less" : "Show all") { withAnimation { expanded.toggle() } }
                }
            }
            .buttonStyle(.borderless)
            .font(AceDesign.Typeface.body)
            .foregroundStyle(AceDesign.Ink.primary)
            .frame(minHeight: AceDesign.Size.tap)
        }
        .padding(.top, AceDesign.Space.tight)
    }
}

/// "Run now with a note": extra instructions for this run only, added after the saved prompt.
struct AutomationRunNote: View {
    let run: (String) -> Void
    @State private var note = ""
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    var body: some View {
        NavigationStack {
            Form {
                TextField("Anything extra for this run", text: $note, axis: .vertical)
                    .lineLimit(3...10).focused($focused)
                    .accessibilityIdentifier("automation.note")
                    .insetRowBackground()
            }
            .insetGroupedList()
            .navigationTitle("Run with a note").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Run") { run(note.trimmingCharacters(in: .whitespacesAndNewlines)); dismiss() }
                        .disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear { focused = true }
        }
    }
}
