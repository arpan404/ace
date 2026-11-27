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
    /// Start watching the open thread's browser (or `threadId`'s, a Spade bot's hidden thread)
    /// at the view's size (points) and screen scale.
    func openBrowser(size: CGSize, scale: CGFloat, threadId shown: String? = nil) {
        guard let threadId = shown ?? thread?.id, let session = browserSession else { return }
        // Acknowledgements skip the main thread: the daemon's window frees as chunks decode.
        browser.open(threadId: threadId, streams: session.browserStreams) { ack in
            var value: [String: Any] = ["kind": "ack", "sequence": ack.sequence]
            if let generation = ack.generation { value["generation"] = generation }
            if ack.keyframe { value["keyframe"] = true }
            if ack.fallback { value["fallback"] = true }
            Self.action(["type": "browser", "action": value], to: session)
        }
        browserAction(["kind": "open", "threadId": threadId, "viewport": Self.viewport(size, scale)])
    }
    func closeBrowser() {
        guard browser.threadId != nil else { return }
        browser.close(streams: browserStreams)
        browserAction(["kind": "close"])
    }
    /// The view's size changed: a tab showing "this phone" takes it; any other device stays.
    /// `picture`: the page as drawn, so its stream is encoded at that size.
    func browserViewport(size: CGSize, scale: CGFloat, picture: CGSize? = nil) {
        guard browser.threadId != nil else { return }
        var value: [String: Any] = ["kind": "viewport", "viewport": Self.viewport(size, scale)]
        if let picture { value["picture"] = ["width": Double(picture.width), "height": Double(picture.height)] }
        browserAction(value)
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

    /// Show the tab as a device preset (the web's device toolbar); the page is told through `emulate`.
    func browserDevice(_ preset: String) {
        guard canOperate, browser.threadId != nil else { return }
        browserAction(["kind": "device", "preset": preset])
    }
    func browserRotateDevice() {
        guard canOperate, browser.threadId != nil else { return }
        browserAction(["kind": "rotate"])
    }
    /// The device toolbar above the bar, for the shown tab; kept on this phone.
    func browserDeviceToolbar(_ show: Bool) {
        guard browser.threadId != nil else { return }
        browserAction(["kind": "deviceToolbar", "show": show])
    }

    /// The address's speaker (`BrowserSound`): sound turns on here first, inside the tap, then the
    /// tab's mute changes for everyone.
    func browserSoundTap(_ step: BrowserSound.Step, tabId: String) {
        switch step {
        case .playHere: browserSound(true)
        case .unmuteTab(let hereToo):
            if hereToo { browserSound(true) }
            browserMute(tabId, false)
        case .muteTab: browserMute(tabId, true)
        }
    }
    /// This phone plays the page's sound or stops: its pane report says so (`audio`), so the daemon
    /// sends the sound only while it does.
    func browserSound(_ on: Bool) {
        guard browser.threadId != nil else { return }
        browser.setSoundHere(on)
        browserAction(["kind": "audio", "on": on])
    }

    private func browserAction(_ value: [String: Any]) { action(["type": "browser", "action": value]) }
    private static func viewport(_ size: CGSize, _ scale: CGFloat) -> [String: Any] {
        ["width": Double(size.width), "height": Double(size.height), "devicePixelRatio": Double(scale)]
    }
}
