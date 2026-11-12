import SwiftUI

/// A Spade conversation's entries in order, drawn as the thread draws messages: the person's
/// words in the right-aligned bubble, Spade's words as prose, each call it made as one quiet
/// line once it has an outcome, how a reply ended when it didn't finish, and a background job's
/// end. While anything is open the Working line closes it, with Stop for all of it.
struct SpadeTranscript: View {
    let spade: SpadeModel
    let conversation: SpadeModel.Conversation
    let stopping: Bool
    let stop: () -> Void

    var body: some View {
        LazyVStack(alignment: .leading, spacing: AceDesign.Space.section) {
            ForEach(spade.order, id: \.self) { key in
                if let row = spade.entries[key] { SpadeEntryView(row: row, key: key) }
            }
            if let working = conversation.working { workingLine(working) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("spade.transcript")
    }

    private func workingLine(_ working: SpadeModel.Working) -> some View {
        HStack(spacing: AceDesign.Space.related) {
            // Counts in place each second; nothing travels while Spade works.
            TimelineView(.periodic(from: .now, by: 1)) { context in
                StatusLabel(word: working.label, tone: working.moving ? .working : .needsYou,
                            glyph: working.moving ? .working : .needsYou,
                            elapsed: working.since.map { Elapsed.words(since: $0, now: context.date) },
                            live: working.moving)
            }
            Spacer(minLength: AceDesign.Space.related)
            if conversation.busy {
                Button(stopping ? "Stopping…" : "Stop", action: stop)
                    .buttonStyle(.textAction())
                    .disabled(stopping)
                    .accessibilityLabel("Stop Spade")
                    .accessibilityIdentifier("spade.stop")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("spade.working")
    }
}

/// One entry of the transcript.
private struct SpadeEntryView: View {
    let row: SpadeModel.Row
    let key: String
    var body: some View {
        switch row {
        case .user(let text, let images, let pending):
            VStack(alignment: .trailing, spacing: AceDesign.Space.tight) {
                if let images { quiet(images).frame(maxWidth: .infinity, alignment: .trailing) }
                if !text.isEmpty { UserBubble(text: text, id: key) }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .opacity(pending ? AceDesign.Ink.pressed : 1)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("spade.message.user")
        case .reply(let parts, let live, let end):
            VStack(alignment: .leading, spacing: AceDesign.Space.related) {
                ForEach(parts) { part in
                    if part.kind == "text" {
                        AceMarkdown(text: part.text)
                    } else {
                        quiet(part.text, tone: part.failed ? AceTheme.StatusText.failed : AceDesign.Ink.muted)
                    }
                }
                if !live.isEmpty { AceMarkdown(text: live, streaming: true) }
                if let end {
                    quiet(end.text, tone: end.alert ? AceTheme.StatusText.failed : AceDesign.Ink.muted)
                        .accessibilityAddTraits(end.alert ? .isStaticText : [])
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("spade.message.reply")
        case .note(let text, let centred):
            quiet(text).frame(maxWidth: .infinity, alignment: centred ? .center : .leading)
        }
    }

    private func quiet(_ text: String, tone: Color = AceDesign.Ink.muted) -> some View {
        Text(text).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote).foregroundStyle(tone)
    }
}
