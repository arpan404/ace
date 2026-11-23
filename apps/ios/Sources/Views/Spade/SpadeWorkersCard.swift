import SwiftUI

/// The workers one call started (ADR 0161), where the bot started them: the card's heading, then
/// each worker with its state's glyph, its name and how it stands, which opens its thread (an ace
/// agent) or its chat (a bot). Under a worker waiting on the person sit its requests on the
/// thread's own cards, so a plan is approved or sent back, a question answered, right here
/// (`NeedsRequestCard`, answering through the inbox's path), whether they wait on its own thread
/// or on one it delegated. The words and states are the bridge's.
struct SpadeWorkersCard: View {
    let workers: SpadeModel.Workers
    let client: ClientModel
    /// Opens a bot worker's chat over this one.
    let openChat: (String) -> Void
    @Environment(\.openURL) private var openURL
    /// What each question card holds while the person answers, by request.
    @State private var drafts: [String: QuestionDraftState] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            Text(workers.title)
                .aceFont(AceDesign.TextRole.meta)
                .foregroundStyle(AceDesign.Ink.muted)
                .accessibilityAddTraits(.isHeader)
            ForEach(workers.workers) { worker in
                VStack(alignment: .leading, spacing: AceDesign.Space.related) {
                    row(worker)
                    if worker.tone == "needs-you" {
                        ForEach(asking(worker), id: \.self) { thread in
                            ForEach(client.needsYou(thread)) { request in
                                NeedsRequestCard(request: request, model: client, threadId: thread,
                                                 open: { openThread(thread) }, draft: draft(request.id))
                            }
                        }
                    }
                }
            }
        }
        .padding(AceDesign.Space.margin)
        .background(AceDesign.Surface.fill, in: AceDesign.Shape.container)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("spade.workers")
    }

    /// A worker that opens its thread or chat is a button that shows its line cut; one that
    /// opens nothing shows its line whole on a tap (`ExpandableText`).
    @ViewBuilder private func row(_ worker: SpadeModel.Workers.Worker) -> some View {
        if opens(worker) {
            Button { open(worker) } label: { label(worker, expands: false) }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityHint(worker.thread != nil ? "Opens its thread" : "Opens its chat")
                .accessibilityIdentifier("spade.worker")
        } else {
            label(worker, expands: true)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("spade.worker")
        }
    }

    private func label(_ worker: SpadeModel.Workers.Worker, expands: Bool) -> some View {
        let tone = AceTone(worker.tone)
        return HStack(spacing: AceDesign.Space.related) {
            StatusGlyph(GlyphState(tone: tone), tone: tone, size: AceDesign.Size.icon, live: tone == .working)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Text(worker.name)
                    .aceFont(AceDesign.TextRole.rowTitle)
                    .foregroundStyle(AceDesign.Ink.primary)
                    .lineLimit(1)
                Group {
                    if expands { ExpandableText(worker.line, id: "worker:\(worker.id)") } else { Text(worker.line).lineLimit(2) }
                }
                .aceFont(AceDesign.TextRole.meta)
                .foregroundStyle(tone == .needsYou ? AceTheme.StatusText.needsYou
                    : tone == .failed ? AceTheme.StatusText.failed : AceDesign.Ink.muted)
            }
            Spacer(minLength: AceDesign.Space.related)
            if !expands {
                AceIcon(.caretRight, size: AceDesign.Size.glyphMeta, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
            }
        }
        .frame(minHeight: AceDesign.Size.tap)
        .contentShape(Rectangle())
    }

    /// The threads whose requests show under a waiting worker.
    private func asking(_ worker: SpadeModel.Workers.Worker) -> [String] {
        worker.asking ?? worker.thread.map { [$0] } ?? []
    }

    private func opens(_ worker: SpadeModel.Workers.Worker) -> Bool {
        worker.thread != nil || worker.conversation != nil
    }

    /// A request's own thread: a delegated descendant's, not the worker's.
    private func openThread(_ thread: String) { openURL(AceLink.thread(thread, machine: client.hostId)) }

    private func open(_ worker: SpadeModel.Workers.Worker) {
        if let thread = worker.thread { openThread(thread) }
        else if let conversation = worker.conversation { openChat(conversation) }
    }

    private func draft(_ id: String) -> Binding<QuestionDraftState> {
        Binding(get: { drafts[id] ?? QuestionDraftState() }, set: { drafts[id] = $0 })
    }
}
