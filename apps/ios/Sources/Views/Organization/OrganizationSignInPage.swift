import SwiftUI

/// Settings › Organization › Sign-in (ADR 0206 §1.3, §2.7): the organization's domain, single
/// sign-on and directory, each set up in the sign-in provider's Admin Portal, opened in the
/// system browser. A link lasts five minutes and is tied to the admin who opened it, so removing
/// them ends it. ace adds no sign-in rules of its own.
struct OrganizationSignInPage: View {
    let admin: OrganizationAdmin
    @Environment(\.openURL) private var openURL
    @State private var opening: AceOrgPortalIntent?
    @State private var notice: String?

    private struct SetupTask: Identifiable {
        let intent: AceOrgPortalIntent
        let title: String
        let detail: String
        var id: String { intent.rawValue }
    }
    private static let tasks = [
        SetupTask(intent: .domainVerification, title: "Email domain",
                  detail: "Prove your team's domain with a DNS record. With it, people on it can join as members when they sign in."),
        SetupTask(intent: .sso, title: "Single sign-on",
                  detail: "Sign in through your identity provider (SAML or OIDC). Once it's set up, members sign in only that way."),
        SetupTask(intent: .dsync, title: "Directory",
                  detail: "Add and remove members from your directory (SCIM). Roles it sets can't be changed in ace."),
    ]

    var body: some View {
        List {
            Section {
                ForEach(Self.tasks) { task in
                    VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                        Text(task.title).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                        Text(task.detail).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                        Button(opening == task.intent ? "Opening…" : "Set up") { open(task.intent) }
                            .buttonStyle(.rowAction)
                            .disabled(opening != nil)
                            .accessibilityIdentifier("organization.signIn.\(task.intent.rawValue)")
                    }
                    .padding(.vertical, AceDesign.Space.tight)
                }
            } header: {
                InsetHeader("Sign-in")
            } footer: {
                Text("Each opens your sign-in provider's setup page in your browser for a few minutes.")
                    .aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .organizationNotice($notice)
    }

    private func open(_ intent: AceOrgPortalIntent) {
        opening = intent
        Task {
            defer { opening = nil }
            switch await admin.portal(intent) {
            case .success(let url): openURL(url)
            case .failure(let refused): notice = refused.sentence
            }
        }
    }
}
