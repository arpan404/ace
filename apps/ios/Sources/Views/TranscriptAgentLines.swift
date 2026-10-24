import SwiftUI

/// A question where the agent asked it, worded by the bridge as the web's line. While it waits:
/// "Codex is asking · Tabs or spaces?" in the row's own ink (its card is the composer). Once
/// closed: "Codex asked · Tabs or spaces? → Spaces", or how it ended.
struct QuestionAskedLine: View {
    let question: BlockRow.Question
    var body: some View {
        QuietRow(icon: question.asking ? .chatCircle : .chatText,
                 tint: question.asking ? AceTheme.Colours.foreground : AceTheme.Colours.subtleForeground) {
            words.lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("transcript.question")
    }
    private var words: Text {
        if question.asking {
            return Text("\(question.asker) is asking · ") + Text(question.title).foregroundStyle(AceTheme.Colours.foreground)
        }
        var line = Text("\(question.asker) asked · \(question.title)")
        if !question.answer.isEmpty {
            line = line + Text(" → ").foregroundStyle(AceTheme.Colours.subtleForeground) + Text(question.answer)
        }
        if !question.outcome.isEmpty {
            line = line + Text(" · \(question.outcome)").foregroundStyle(AceTheme.Colours.subtleForeground)
        }
        return line
    }
}

/// A conversation an agent started (or forked), as an agent row where it was started: its
/// provider's mark, its title, "New thread" or "Fork", and the child thread's own status once the
/// thread list knows it. The row opens it.
struct StartedThreadRow: View {
    let started: BlockRow.Started
    let status: StatusDisplay?
    let open: (String) -> Void
    var body: some View {
        AgentRow(entry: BlockRow.Agents.Entry(id: started.threadId, agentId: "", threadId: started.threadId, title: started.title,
                                              state: "", label: status?.label ?? "", token: status?.token ?? "",
                                              provider: started.provider, model: started.model, result: "", meta: started.label)) { _ in
            open(started.threadId)
        }
    }
}
