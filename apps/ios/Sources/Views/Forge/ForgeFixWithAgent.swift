import SwiftUI

/// "Fix with agent" from a review comment, as the web's: the request goes into the composer of
/// the thread working on this pull request (the first one linked and not archived) for the person
/// to read over and send; nothing is sent for them. With no thread linked, a new one starts on the
/// pull request with the request written in.
struct ForgeFixer {
    let machineId: String
    let project: String
    let openThread: (InboxKey) -> Void
    /// Nil where the phone can't start threads.
    let startThread: (() -> Void)?

    /// The pull request page, which names its threads, head and title: the one this phone last
    /// read when there is one, read from the machine when not (a timeline opened on its own).
    @MainActor func page(_ client: ClientModel, _ target: ForgePullTarget) async -> ForgePullPage? {
        let saved = UserDefaults.standard.string(forKey: "ace.git.mergeMethod") ?? ""
        let read = ClientModel.forgePullRead(project: target.project, number: target.number, repository: target.repository,
                                             method: saved.isEmpty ? "squash" : saved)
        if let kept = client.kept(read, as: ForgePullPage.self) { return kept }
        return try? await client.read(read, as: ForgePullPage.self)
    }

    /// Hands `request` on; false when nothing could take it.
    @MainActor func fix(_ request: String, client: ClientModel, target: ForgePullTarget, drafts: ThreadDrafts?) async -> Bool {
        guard client.canOperate, let page = await page(client, target) else { return false }
        if let thread = page.threads.first(where: { !$0.archived }) {
            guard client.handOff(request, to: thread.id, drafts: drafts) else { return false }
            openThread(InboxKey(machineId: machineId, id: thread.id))
            return true
        }
        guard let startThread else { return false }
        NewThreadDraftStore.standard().seed(
            machineId: machineId, projectId: project,
            pullRequest: NewThreadPull(repository: page.repository, number: page.number, headSha: page.headSha, title: page.title),
            text: request)
        startThread()
        return true
    }
}
