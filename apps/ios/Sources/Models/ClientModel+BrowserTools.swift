import Foundation

/// What the person does with the open thread's browser besides touching the page
/// (`bridge/browser-tools.ts`). A view-only grant sends none of it.
extension ClientModel {
    /// What was typed into the address bar; the bridge decides whether it is an address.
    func browserGo(_ text: String) { browserTool(["kind": "go", "text": text]) }
    func browserNewTab(_ text: String? = nil) {
        var value: [String: Any] = ["kind": "newTab"]
        if let text, !text.isEmpty { value["text"] = text }
        browserTool(value)
    }
    func browserCloseTab(_ tabId: String) { browserTool(["kind": "closeTab", "tabId": tabId]) }
    /// Take over (`true`: agents are kept out of the tab) or hand it back.
    func browserTakeOver(_ tabId: String, _ value: Bool) { browserTool(["kind": "private", "tabId": tabId, "value": value]) }
    func browserFind(_ text: String, forward: Bool = true) { browserTool(["kind": "find", "text": text, "forward": forward]) }
    func browserZoom(_ step: String) { browserTool(["kind": "zoom", "step": step]) }
    func browserScreenshot(fullPage: Bool) { browserTool(["kind": "screenshot", "fullPage": fullPage]) }
    /// The console sheet's filter (section console or network, level, requests); nil closes it.
    func browserConsole(section: String, level: String, requests: String, clear: Bool = false) {
        browserTool(["kind": "console", "filter": ["section": section, "level": level, "requests": requests], "clear": clear], readOnly: true)
    }
    func closeBrowserConsole() {
        browserTool(["kind": "console", "clear": false], readOnly: true)
        browser.clearLogs()
    }
    func browserVisits(open: Bool, query: String = "") { browserTool(["kind": "visits", "open": open, "query": String(query.prefix(256))], readOnly: true) }
    func browserForget(_ visit: BrowserVisit) { browserTool(["kind": "forget", "url": visit.url, "at": visit.at], readOnly: true) }
    func browserAnswer(_ dialog: BrowserViewInfo.Dialog, accept: Bool, text: String? = nil) {
        var value: [String: Any] = ["kind": "dialog", "tabId": dialog.tabId, "dialogId": dialog.dialogId, "accept": accept]
        if let text { value["text"] = text }
        browserTool(value)
    }
    /// The site's sign-in; nil cancels it. The credentials go to the page's browser only.
    func browserSignIn(_ challenge: BrowserViewInfo.SignIn, username: String?, password: String?) {
        var value: [String: Any] = ["kind": "signIn", "tabId": challenge.tabId, "authId": challenge.authId]
        if let username, let password { value["credentials"] = ["username": username, "password": password] }
        browserTool(value)
    }
    /// Files for the page's picker, staged on the phone first; none cancels it.
    func browserFiles(_ chooser: BrowserViewInfo.Chooser, _ files: [StagedAttachment]) {
        browserTool(["kind": "files", "tabId": chooser.tabId, "chooserId": chooser.chooserId, "files": files.map(\.json)])
    }
    func browserProceed(_ tabId: String, url: String) { browserTool(["kind": "certificate", "tabId": tabId, "url": url]) }
    func browserReopen() { browserTool(["kind": "reopen"]) }

    private func browserTool(_ value: [String: Any], readOnly: Bool = false) {
        guard readOnly || canOperate, browser.threadId != nil else { return }
        action(["type": "browser", "action": value])
    }
}
