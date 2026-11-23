import SwiftUI

/// The profile's Work tab (ADR 0159, 0161, 0165), as web's: the goal the bot works toward with
/// each criterion's verdict, the plan with each step's mark and the evidence it collected (each
/// piece says where in the conversation it came from), the workers it runs, and the choices it
/// made for the person. Change on a decision quotes it into the bot's composer. Read as the tab
/// shows and again while it does, sooner while the bot works.
struct SpadeProfileWork: View {
    let client: ClientModel
    let agent: String
    /// Change on a decision: these words go into the composer.
    let quote: (String) -> Void
    @State private var work: SpadeWork?
    @State private var problem: String?

    var body: some View {
        Group {
            if let work {
                if work.empty {
                    Section { SpadeProfileNone(text: "No goal, workers or decisions yet.") }
                }
                if let goal = work.goal { SpadeWorkGoal(goal: goal) }
                if !work.workers.isEmpty { workers(work) }
                if !work.decisions.isEmpty { decisions(work.decisions) }
            } else if let problem {
                ProblemRow(problem, id: "spade.work.problem") { Task { await load() } }
            } else {
                SkeletonRows(count: 3).listRowInsets(EdgeInsets())
            }
        }
        .task(id: agent) {
            // While the tab shows: again every few seconds while the bot works, slower at rest.
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(work?.moving == true ? 4 : 15))
            }
        }
    }

    private func workers(_ work: SpadeWork) -> some View {
        Section {
            ForEach(work.workers) { worker in
                HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
                    VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                        Text(worker.name).aceFont(AceDesign.TextRole.rowTitle)
                        Text(worker.line).aceFont(AceDesign.TextRole.meta).foregroundStyle(Self.tone(worker.tone))
                    }
                    Spacer(minLength: AceDesign.Space.related)
                    if let spend = worker.spend {
                        Text(spend).aceFont(AceDesign.TextRole.meta).monospacedDigit()
                            .foregroundStyle(AceDesign.Ink.muted)
                    }
                }
                .padding(.leading, CGFloat(worker.depth) * AceDesign.Space.group)
                .accessibilityElement(children: .combine)
            }
        } header: {
            HStack {
                Text("Workers")
                Spacer()
                if let spend = work.spend { Text("\(spend) in all").monospacedDigit() }
            }
        }
    }

    private func decisions(_ decisions: [SpadeWork.Decision]) -> some View {
        Section("Decided for you") {
            ForEach(decisions) { decision in
                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                    Text(decision.choice).aceFont(AceDesign.TextRole.rowTitle)
                    if !decision.reason.isEmpty {
                        Text(decision.reason).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                    }
                    HStack {
                        Text(Self.time(decision.at)).aceFont(AceDesign.TextRole.time)
                            .foregroundStyle(AceDesign.Ink.subtle)
                        Spacer()
                        Button("Change") { quote(decision.quote) }
                            .aceFont(AceDesign.TextRole.action)
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Change: \(decision.choice)")
                            .accessibilityIdentifier("spade.work.change")
                    }
                }
            }
        }
    }

    static func tone(_ tone: String) -> Color {
        switch tone {
        case "needs-you": AceTheme.StatusText.needsYou
        case "failed": AceTheme.StatusText.failed
        default: AceDesign.Ink.muted
        }
    }

    static func time(_ ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(date: .abbreviated, time: .shortened)
    }

    private func load() async {
        let answer = await client.spadeWork(agent)
        if answer.ok, let fresh = answer.part {
            work = fresh
            problem = nil
        } else if work == nil {
            problem = answer.problem ?? "Couldn't read its work."
        }
    }
}

/// The goal: its title and the person's words, each criterion with the check's verdict, then the
/// plan, each step with its mark, its one note and its evidence.
struct SpadeWorkGoal: View {
    let goal: SpadeWork.Goal

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                Text(goal.title).aceFont(AceDesign.TextRole.header)
                if !goal.text.isEmpty {
                    Text("“\(goal.text)”").aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                }
            }
            ForEach(goal.criteria, id: \.self) { criterion in
                HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
                    mark(criterion.met ? "verified" : "open")
                    VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                        Text(criterion.text).aceFont(AceDesign.TextRole.rowTitle)
                        if let why = criterion.why {
                            Text(why).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                        }
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityValue(criterion.met ? "Met" : "Not met yet")
            }
            if let note = goal.note { SpadeProfileNone(text: note) }
        } header: {
            HStack {
                Text("Goal")
                Spacer()
                if !goal.heading.isEmpty {
                    Text(goal.heading).foregroundStyle(goal.done ? AceTheme.StatusText.done : AceDesign.Ink.muted)
                }
            }
        }
        if !goal.plan.isEmpty {
            Section("Plan") {
                ForEach(Array(goal.plan.enumerated()), id: \.offset) { step($0.element) }
                if goal.more > 0 { SpadeProfileNone(text: "\(goal.more) more on the computer") }
            }
        }
    }

    private func step(_ step: SpadeWork.Step) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
            mark(step.mark)
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                Text(step.text).aceFont(AceDesign.TextRole.rowTitle)
                if let note = step.note {
                    Text(note.tone == "waiting" ? note.text : "Not yet: \(note.text)")
                        .aceFont(AceDesign.TextRole.meta)
                        .foregroundStyle(note.tone == "waiting" ? AceTheme.StatusText.needsYou : AceDesign.Ink.muted)
                }
                ForEach(step.evidence, id: \.self) { evidence in
                    Text(Self.evidence(evidence)).aceFont(AceDesign.TextRole.meta)
                        .foregroundStyle(AceDesign.Ink.subtle)
                        .lineLimit(2)
                }
            }
        }
        .padding(.leading, CGFloat(step.depth) * AceDesign.Space.group)
        .accessibilityElement(children: .combine)
        .accessibilityValue(Self.markWords[step.mark] ?? "")
    }

    /// A piece of evidence and where it came from: a command's output names the reply that ran it.
    static func evidence(_ evidence: SpadeWork.Evidence) -> String {
        switch evidence.kind {
        case "file": return "File: \(evidence.words)"
        case "url": return "Page: \(evidence.words)"
        default:
            guard let at = evidence.at else { return evidence.words }
            return "\(evidence.words) · its reply at \(SpadeProfileWork.time(at))"
        }
    }

    static let markWords = ["verified": "Verified", "claimed": "Done, not checked", "working": "In progress",
                            "waiting": "Waits on you", "open": "Not started"]

    private func mark(_ mark: String) -> some View {
        let (name, weight, tint): (AceIcon.Name, AceIcon.Weight, Color) = switch mark {
        case "verified": (.checkCircle, .fill, AceTheme.StatusText.done)
        case "claimed": (.checkCircle, .regular, AceDesign.Ink.muted)
        case "working": (.circleDashed, .regular, AceDesign.Ink.muted)
        case "waiting": (.hand, .regular, AceTheme.StatusText.needsYou)
        default: (.circle, .regular, AceDesign.Ink.subtle)
        }
        return AceIcon(name, size: 16, weight: weight).foregroundStyle(tint)
    }
}
