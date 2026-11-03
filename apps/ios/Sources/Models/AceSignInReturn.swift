import Foundation

/// `ace://account/signed-in?status=<status>`: where the browser comes back to when ace sign-in
/// ends (ADR 0100). It carries only how the sign-in ended, never a credential: the session still
/// comes from the app's own claim. It isn't a link into ace, so link handling ignores it.
enum AceSignInReturn {
    static let address = "ace://account/signed-in"
    static let statuses: Set<String> = ["signed-in", "cancelled", "failed", "expired"]

    /// Any `ace://account/...` URL: sign-in's, never a thread or settings link.
    static func isAccountURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == AceLink.scheme && url.host?.lowercased() == "account"
    }

    /// The status a returned sign-in URL carries; nil for anything else.
    static func status(_ url: URL) -> String? {
        let text = url.absoluteString
        let prefix = address + "?status="
        guard text.hasPrefix(prefix) else { return nil }
        let status = String(text.dropFirst(prefix.count))
        return statuses.contains(status) ? status : nil
    }

    /// What Profile says about a sign-in that came back without finishing; nil once signed in.
    static func message(_ status: String?) -> String? {
        switch status {
        case "cancelled": "Sign-in was cancelled."
        case "expired": "That sign-in expired or was already used. Try again."
        case "failed": "Couldn't sign in. Try again."
        default: nil
        }
    }
}
