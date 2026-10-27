import SwiftUI

/// The thread's Offshift run, as the web Summary shows it: its word against the whole agent tree
/// (never Done while anything works or waits) and phase, what blocks it, what it does next, the
/// current phase's steps, each criterion with the checks it still needs and who recorded each,
/// and the outcome it is for. Headings over hairline-free rows; only Failed and needs-you are loud.
struct OffshiftRunView: View {
    let screen: ThreadScreenModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        List {
            if let run = screen.offshift {
                Section {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                        HStack(spacing: AceTheme.Spacing.sm) {
                            StateLabel(status: StatusDisplay(label: run.word, token: run.token))
                            Text(run.phase).foregroundStyle(AceTheme.Colours.mutedForeground).monospacedDigit()
                        }
                        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("offshift.state")
                        Text(run.outcome).aceFont(AceTheme.Typography.body, relativeTo: .body)
                            .foregroundStyle(AceTheme.Colours.foreground)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("Ends at \(run.endpoint)").aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                    .padding(.vertical, AceTheme.Spacing.xs)
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
                    if let blocker = run.blocker {
                        LabeledLine(title: "Blocked", text: blocker).accessibilityIdentifier("offshift.blocker")
                    } else if let next = run.next, !run.done {
                        LabeledLine(title: "Next", text: next).accessibilityIdentifier("offshift.next")
                    }
                }
                .listSectionSeparator(.hidden)
                if !run.steps.isEmpty {
                    Section {
                        ForEach(run.steps) { step in RunStepLine(step: step) }
                    } header: { InsetHeader("Steps") }
                    .listSectionSeparator(.hidden)
                }
                if !run.criteria.isEmpty {
                    Section {
                        ForEach(run.criteria) { criterion in CriterionLine(criterion: criterion) }
                        if run.moreCriteria > 0 {
                            Text("\(run.moreCriteria) more on the run's record")
                                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                                .foregroundStyle(AceTheme.Colours.mutedForeground)
                                .listRowSeparator(.hidden).listRowBackground(Color.clear)
                        }
                    } header: {
                        InsetHeader(run.pending > 0 ? "Criteria · \(run.pending) \(run.pending == 1 ? "check" : "checks") open" : "Criteria")
                    }
                    .listSectionSeparator(.hidden)
                }
                Section {
                    Text("The agent records this run as it works. Ask it in the thread to change the plan or add a check.")
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .listRowSeparator(.hidden).listRowBackground(Color.clear)
                }
                .listSectionSeparator(.hidden)
            } else {
                EmptyState(icon: .listChecks, title: "No Offshift run", line: "This thread isn't running one now.") { EmptyView() }
            }
        }
        .listStyle(.plain)
        .listRowSeparator(.hidden)
        .listSectionSeparator(.hidden)
        .scrollContentBackground(.hidden)
        .background(AceTheme.Colours.background)
        .listRowBackground(Color.clear)
        .animation(reduceMotion ? nil : .smooth, value: screen.offshift)
        .navigationTitle("Offshift run")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("offshift.run")
    }
}

/// "Blocked" or "Next" over its sentence.
private struct LabeledLine: View {
    let title: String
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            Text(title).aceFont(AceTheme.Typography.caption, relativeTo: .caption).fontWeight(.semibold)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
            Text(text).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                .foregroundStyle(AceTheme.Colours.foreground).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, AceTheme.Spacing.xs)
        .accessibilityElement(children: .combine)
        .listRowSeparator(.hidden).listRowBackground(Color.clear)
    }
}

/// A step: done and skipped step back a tier; a skipped one says why underneath.
private struct RunStepLine: View {
    let step: OffshiftRun.Step
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
            StatusGlyph(step.state == "Done" ? .done : .idle, tone: step.state == "Done" ? .done : .idle, size: 12)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(step.title).foregroundStyle(step.state == "To do" ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                    .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                if let reason = step.reason {
                    Text(reason).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.subtleForeground)
                }
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            Text(step.state).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
        }
        .padding(.vertical, AceTheme.Spacing.xxs)
        .accessibilityElement(children: .combine)
        .listRowSeparator(.hidden).listRowBackground(Color.clear)
    }
}

/// A criterion: whether it holds, the checks it still needs (a failed one loud), and under it
/// each required check's standing and who recorded it.
private struct CriterionLine: View {
    let criterion: OffshiftRun.Criterion
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
                StatusGlyph(glyph, tone: tone, size: 12)
                Text(criterion.description)
                    .foregroundStyle(criterion.state == "Met" ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground)
                    .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !criterion.needs.isEmpty {
                criterion.needs.enumerated().reduce(Text("Needs ")) { line, need in
                    line + Text(need.offset > 0 ? " · " : "")
                        + Text(need.element.kind).foregroundStyle(need.element.failed ? AceTheme.StatusText.failed : AceTheme.Colours.mutedForeground)
                }
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .padding(.leading, AceTheme.Spacing.lg)
            }
            ForEach(criterion.evidence, id: \.self) { line in
                Text(line).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
                    .padding(.leading, AceTheme.Spacing.lg)
            }
        }
        .padding(.vertical, AceTheme.Spacing.xs)
        .accessibilityElement(children: .combine)
        .listRowSeparator(.hidden).listRowBackground(Color.clear)
    }
    private var glyph: GlyphState { criterion.state == "Met" ? .done : criterion.state == "Failed" ? .failed : .idle }
    private var tone: AceTone { criterion.state == "Met" ? .done : criterion.state == "Failed" ? .failed : .idle }
}
