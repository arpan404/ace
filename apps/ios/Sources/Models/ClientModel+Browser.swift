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
