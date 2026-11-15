import SwiftUI

/// `automations.threadLine` (`bridge/automations.ts`): the web strip's sentence for a thread's
/// automations, and its actions; Pause and Resume carry the write they send.
struct ThreadAutomationLine: Decodable, Sendable, Equatable {
    struct Action: Decodable, Sendable, Equatable {
        let label: String
        /// Pause or Resume: the write it sends.
        let write: ServiceValue?
        /// Open: the automation's page.
        let automationId: String?
        /// Open run: the thread the run works in.
        let threadId: String?
    }
    let text: String
    let actions: [Action]
}
private struct ThreadAutomationLineReply: Decodable, Sendable { let ok: Bool; let line: ThreadAutomationLine? }
private struct AutomationWriteReply: Decodable, Sendable { let ok: Bool; let error: String? }

/// One quiet line above the composer for the automations an agent made from this thread, as the
/// web's composer strip shows: what they do and when, with Pause or Resume. Nothing when the
/// thread has none.
struct ThreadAutomationStrip: View {
    let model: ClientModel
    let threadId: String
    @State private var line: ThreadAutomationLine?
    @State private var problem: String?
    @State private var busy = false
    /// The automation Open shows, in a sheet over the thread.
    @State private var opened: OpenedAutomation?
    private struct OpenedAutomation: Identifiable { let id: String }

    var body: some View {
        Group {
            if let line {
                HStack(spacing: AceDesign.Space.related) {
                    Text(problem ?? line.text)
                        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(problem == nil ? AceDesign.Ink.muted : AceTheme.Status.failed)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    ForEach(shown(line), id: \.label) { action in
                        Button(action.label) { act(action) }
                            .buttonStyle(.textAction())
                            .disabled(busy)
                            .accessibilityIdentifier("thread.automation.\(action.label.lowercased().replacingOccurrences(of: " ", with: "."))")
                    }
                }
                .padding(.leading, ComposerCapsuleMetrics.aboveInset)
                .padding(.trailing, AceDesign.Space.margin)
                .padding(.bottom, AceDesign.Space.tight)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("thread.automation")
            }
        }
        // Again every half minute and when the machine reconnects: an agent may make one, and a
        // run finishes, while the thread is open.
        .task(id: "\(threadId):\(model.connection)") {
            while !Task.isCancelled {
                await read()
                try? await Task.sleep(for: .seconds(30))
            }
        }
        .sheet(item: $opened) { automation in
            NavigationStack { AutomationDetailView(model: model, id: automation.id) }
        }
    }

    /// The actions this phone can take: Pause and Resume only where it may act, Open where there
    /// is one automation to show (the list lives in Settings), Open run always.
    private func shown(_ line: ThreadAutomationLine) -> [ThreadAutomationLine.Action] {
        line.actions.filter { action in
            if action.write != nil { return model.canOperate }
            return action.automationId != nil || action.threadId != nil
        }
    }

    private func act(_ action: ThreadAutomationLine.Action) {
        if action.write != nil { Task { await send(action) } }
        else if let id = action.automationId { opened = OpenedAutomation(id: id) }
        else if let thread = action.threadId { model.deepLink = thread }
    }

    private func read() async {
        let request: [String: Any] = ["type": "automations.threadLine", "threadId": threadId, "zone": TimeZone.current.identifier]
        if let reply = try? await model.service(request, as: ThreadAutomationLineReply.self), reply.ok { line = reply.line }
    }

    private func send(_ action: ThreadAutomationLine.Action) async {
        guard let write = action.write else { return }
        busy = true
        defer { busy = false }
        let reply = try? await model.service(["type": "automations.write", "request": write.json], as: AutomationWriteReply.self)
        problem = reply?.ok == true ? nil : (reply?.error ?? "Couldn't change the automation. Try again.")
        await read()
    }
}
