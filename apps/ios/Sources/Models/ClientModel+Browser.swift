import CoreGraphics
import Foundation

/// The open thread's live browser view (`bridge/browser-live.ts`). The bridge subscribes and sends
/// input; pictures come straight from this runtime's sockets to `browser`.
extension ClientModel {
    /// Whether the open thread has a browser with a tab open, for its Browser entry.
    var threadHasBrowser: Bool {
        guard let thread else { return false }
        return browser.hasBrowser(thread.id, epoch: thread.epoch)
    }
    /// Ask again whether the open thread has a browser (the agent may have opened one since).
    func probeBrowser() {
        guard let thread else { return }
        browserAction(["kind": "probe", "threadId": thread.id, "epoch": thread.epoch])
    }
    /// Waits between probes while the open thread works without a browser: about two minutes in
    /// all, then quiet until its state changes or the person comes back to it.
    static let browserFollowDelays: [Duration] = [.seconds(3), .seconds(5), .seconds(10), .seconds(20), .seconds(30), .seconds(60)]
    /// The agent can open a browser mid-turn without changing the thread's state. While the
    /// thread on screen works and has none, ask again after each delay; stops as soon as one is
    /// found, the turn settles, another visit begins or the caller's task is cancelled.
    func followBrowser(sleep: (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) async {
        guard let thread else { return }
        let id = thread.id, epoch = thread.epoch
        for delay in Self.browserFollowDelays {
            do { try await sleep(delay) } catch { return }
            guard !Task.isCancelled, let current = self.thread, current.id == id, current.epoch == epoch,
                  current.screen.controls?.busy == true, !threadHasBrowser else { return }
            probeBrowser()
        }
    }
    /// Start watching the open thread's browser at the view's size (points) and screen scale.
    func openBrowser(size: CGSize, scale: CGFloat) {
        guard let thread else { return }
        let threadId = thread.id
        browser.open(threadId: threadId, streams: browserStreams) { [weak self] ack in
            var value: [String: Any] = ["kind": "ack", "sequence": ack.sequence]
            if ack.video { value["video"] = true }
            if ack.keyframe { value["keyframe"] = true }
            self?.browserAction(value)
        }
        browserAction(["kind": "open", "threadId": threadId, "viewport": Self.viewport(size, scale)])
    }
    func closeBrowser() {
        guard browser.threadId != nil else { return }
        browser.close(streams: browserStreams)
        browserAction(["kind": "close"])
    }
    /// The view's size changed: the page lays out at it, as a touch screen.
    func browserViewport(size: CGSize, scale: CGFloat) {
        guard browser.threadId != nil else { return }
        browserAction(["kind": "viewport", "viewport": Self.viewport(size, scale)])
    }
    /// The person's touches, keys, text and picks; a view-only grant sends none.
    func browserInput(_ inputs: [RemoteInput]) {
        guard canOperate, browser.threadId != nil else { return }
        for input in inputs { browserAction(["kind": "input", "input": input.json]) }
    }
    func browserHistory(_ direction: String) {
        guard canOperate, browser.threadId != nil else { return }
        browserAction(["kind": "history", "direction": direction])
    }
    func browserSelectTab(_ tabId: String) {
        guard canOperate, browser.threadId != nil else { return }
        browserAction(["kind": "tab", "tabId": tabId])
    }

    private func browserAction(_ value: [String: Any]) { action(["type": "browser", "action": value]) }
    private static func viewport(_ size: CGSize, _ scale: CGFloat) -> [String: Any] {
        ["width": Double(size.width), "height": Double(size.height), "devicePixelRatio": Double(scale)]
    }
}
