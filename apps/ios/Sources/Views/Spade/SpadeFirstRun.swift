import SwiftUI

/// The foot of the main Spade's chat (spade/docs/memory.md, About you): while Spade has no model
/// it can use, the setup card (`SpadeKeySetupCard`); once it has one, the About-you interview,
/// whose answers become the shared notes every bot reads. Nothing on any other chat. Read as the
/// chat opens and whenever Spade's state moves; what to show is the bridge's.
struct SpadeFirstRunFoot: View {
    let client: ClientModel
    let conversation: String
    @State private var foot: SpadeOnboarding.Foot?
    /// Later: the interview waits until the chat opens again. Held by the conversation, so the
    /// foot drawn again (a sent message moves the rows) keeps it.
    @Binding var later: Bool

    var body: some View {
        Group {
            if let setup = foot?.setup {
                SpadeKeySetupCard(setup: setup) { choice, key, address, model in
                    let answer = await client.spadeOnboardingModel(conversation, choice: choice, key: key, address: address, model: model)
                    // A refused setup that made its endpoint offers it for the retry.
                    if answer.ok || answer.foot != nil { foot = answer.foot }
                    return answer
                }
            } else if let about = foot?.aboutYou, !later {
                SpadeFirstRun(about: about) { answers, skip in
                    let answer = await client.spadeOnboardingAboutYou(conversation, answers: answers, skip: skip)
                    if answer.ok { foot = answer.foot }
                    return answer
                } later: {
                    later = true
                }
            }
        }
        .padding(.top, AceDesign.Space.related)
        .task(id: client.spade.line) { await read() }
    }

    private func read() async {
        let answer = await client.spadeOnboardingRead(conversation)
        // A read that fails leaves the foot as it was: the chat itself is fine.
        if answer.ok { foot = answer.foot }
    }
}

/// The About-you interview: one question at a time, each optional, its quick answers as chips.
/// Done saves the answers as shared notes; Skip ends it for good; Later puts it off.
struct SpadeFirstRun: View {
    let about: SpadeOnboarding.AboutYou
    let save: (_ answers: [String: String]?, _ skip: Bool) async -> SpadeOnboarding.Answer
    let later: () -> Void
    @State private var at = 0
    @State private var answers: [String: String] = [:]
    @State private var saving = false
    @State private var problem: String?
    @FocusState private var focused: Bool

    private var question: SpadeOnboarding.Question? { about.questions.indices.contains(at) ? about.questions[at] : nil }
    private var last: Bool { at >= about.questions.count - 1 }

    var body: some View {
        if let question {
            VStack(alignment: .leading, spacing: AceDesign.Space.row) {
                if at == 0 {
                    Text(about.intro).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                }
                HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
                    StatusGlyph(.needsYou, tone: .needsYou, size: AceDesign.Size.icon)
                    RequestHeader(title: question.ask)
                    Text("\(at + 1) of \(about.questions.count)")
                        .aceFont(AceDesign.TextRole.meta)
                        .foregroundStyle(AceDesign.Ink.muted)
                        .monospacedDigit()
                }
                TextField(question.placeholder, text: answer(question), axis: .vertical)
                    .lineLimit(1...4)
                    .submitLabel(.next)
                    .onSubmit(next)
                    .focused($focused)
                    .modifier(SpadeSetupField())
                    .disabled(saving)
                    .accessibilityIdentifier("spade.aboutYou.field")
                if !question.picks.isEmpty { picks(question) }
                if let problem {
                    Text(problem).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceTheme.StatusText.failed)
                        .accessibilityIdentifier("spade.aboutYou.problem")
                }
                footer(question)
            }
            .spadeSetupCard(label: "About you", id: "spade.aboutYou")
        }
    }

    private func answer(_ question: SpadeOnboarding.Question) -> Binding<String> {
        Binding(get: { answers[question.field] ?? "" }, set: { answers[question.field] = $0 })
    }

    private func picks(_ question: SpadeOnboarding.Question) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: AceDesign.Space.related) {
                ForEach(question.picks, id: \.self) { pick in
                    let chosen = answers[question.field] == pick
                    Button(pick) { answers[question.field] = pick }
                        .buttonStyle(RequestButtonStyle(primary: chosen))
                        .accessibilityAddTraits(chosen ? .isSelected : [])
                }
            }
        }
        .disabled(saving)
    }

    private func footer(_ question: SpadeOnboarding.Question) -> some View {
        let typed = !(answers[question.field] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return HStack(spacing: AceTheme.Spacing.xxs) {
            Button("Skip") { send(skip: true) }
                .buttonStyle(RequestButtonStyle())
                .accessibilityIdentifier("spade.aboutYou.skip")
            Button("Later", action: later)
                .buttonStyle(RequestButtonStyle())
                .accessibilityIdentifier("spade.aboutYou.later")
            Spacer(minLength: AceTheme.Spacing.none)
            Button(last ? (saving ? "Saving…" : "Done") : typed ? "Next" : "Skip this one", action: next)
                .buttonStyle(RequestButtonStyle(primary: true))
                .accessibilityIdentifier("spade.aboutYou.next")
        }
        .disabled(saving)
    }

    private func next() {
        if last { send(skip: false) } else { at += 1 }
    }

    private func send(skip: Bool) {
        guard !saving else { return }
        saving = true
        problem = nil
        Task {
            let answer = await save(skip ? nil : answers, skip)
            saving = false
            if !answer.ok { problem = answer.problem }
        }
    }
}
