import SwiftUI

/// One account on a provider's Accounts page: badge, name, what it is ("Default · API key ·
/// ada@example.com") and its state, then a ⋯ menu with everything it can do. Swiping left offers
/// Edit and Remove. An account that needs signing in shows Sign in on the row instead of its
/// state, since that is the one thing to do with it.
struct ProviderAccountRow: View {
    let account: AccountRowData
    /// The ways to sign in again; more than one turns Sign in into a submenu.
    let ways: [AccountWay]
    let canOperate: Bool
    let signIn: (AccountWay) -> Void
    let makeDefault: () -> Void
    let edit: () -> Void
    let remove: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var choosingWay = false

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                    words
                    HStack(spacing: AceDesign.Space.related) { status; Spacer(minLength: AceDesign.Space.related); actions }
                }
            } else {
                HStack(spacing: AceDesign.Space.row) {
                    AccountBadgeMark(look: account.badge)
                    words
                    Spacer(minLength: AceDesign.Space.related)
                    status
                    actions
                }
            }
        }
        .padding(.vertical, AceDesign.Space.tight)
        .swipeActions(edge: .trailing) {
            if canOperate {
                if account.removable { Button("Remove", role: .destructive, action: remove) }
                Button("Edit", action: edit).tint(AceDesign.Ink.action)
            }
        }
    }

    private var words: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            Text(account.label).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
            let detail = [account.isDefault ? "Default" : nil, account.method, account.signedInAs].compactMap { $0 }.joined(separator: " · ")
            if !detail.isEmpty {
                Text(detail).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                    .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
            }
        }
        .accessibilityElement(children: .combine)
        .layoutPriority(1)
    }

    @ViewBuilder private var status: some View {
        if account.needsSignIn, canOperate, !ways.isEmpty {
            Button("Sign in") { if ways.count > 1 { choosingWay = true } else if let way = ways.first { signIn(way) } }
                .buttonStyle(.secondaryAction).controlSize(.small)
                .accessibilityIdentifier("accounts.signIn.\(account.id)")
                .confirmationDialog("Sign in \(account.label)", isPresented: $choosingWay, titleVisibility: .visible) {
                    ForEach(ways) { way in Button(way.label) { signIn(way) } }
                }
        } else {
            Text(account.state).aceFont(AceDesign.TextRole.action)
                .foregroundStyle(account.tone == "problem" ? AceTheme.StatusText.failed : account.needsSignIn ? AceTheme.StatusText.needsYou : AceDesign.Ink.muted)
                .lineLimit(1)
        }
    }

    @ViewBuilder private var actions: some View {
        if canOperate {
            Menu {
                if !account.needsSignIn {
                    signInAgain { Label("Sign in again", systemImage: "person.badge.key") }
                }
                if account.canMakeDefault {
                    Button("Use by default", systemImage: "checkmark.circle", action: makeDefault)
                }
                Button("Edit name and badge", systemImage: "pencil", action: edit)
                if account.removable {
                    Divider()
                    Button("Remove account", systemImage: "trash", role: .destructive, action: remove)
                }
            } label: { RowActionsMark() }
            .buttonStyle(.borderless)
            .accessibilityLabel("Actions for \(account.label)")
            .accessibilityIdentifier("accounts.actions.\(account.id)")
        }
    }

    /// Sign in by the one way there is, or a menu of the ways when there are several.
    @ViewBuilder private func signInAgain<L: View>(@ViewBuilder label: () -> L) -> some View {
        if ways.count > 1 {
            Menu {
                ForEach(ways) { way in Button(way.label) { signIn(way) } }
            } label: { label() }
        } else if let way = ways.first {
            Button { signIn(way) } label: { label() }
        }
    }
}
