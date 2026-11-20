/// Which browser-help request the thread's browser answers with Done and Skip: the one whose card
/// opened it while it's still open, else the first one open. A request mirrored from another
/// machine waits on a tab there, so this browser never answers it.
enum BrowserHelpPick {
    static func help(in approvals: [ApprovalRow], chosen: String?) -> ApprovalRow? {
        let here = approvals.filter { $0.kind == "browser_help" && $0.help?.elsewhere != true }
        return here.first { $0.id == chosen } ?? here.first
    }
}
