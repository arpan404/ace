import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A webhook automation's addresses and secret (ADR 0173), as the web's panel: one URL per way in
/// that serves, or why none does, each with Copy; the access its runs get; Create secret, or
/// Rotate and Revoke behind a confirm; the new secret once, right after it's made, with Copy; and
/// the headers and prompt variables senders use. The bridge words every line
/// (`bridge/automation-webhooks.ts`). The secret lives only in this view's state: Done, or
/// leaving the screen, loses it for good. It is never written, logged or read back.
struct AutomationWebhookSection: View {
    let model: ClientModel
    let automationId: String
    /// "person", or "thread" for one an agent made from a thread.
    let source: String
    @State private var view: AutomationWebhookView?
    @State private var problem: String?
    @State private var pending = false
    @State private var secret: String?
    @State private var note: String?
    @State private var confirming: Action?
    @State private var copied: String?
    @State private var copies = 0

    /// `create` makes a secret only while there is none; Rotate and Revoke ask first.
    private enum Action: String, Identifiable { case create, rotate, revoke; var id: String { rawValue } }

    var body: some View {
        Section {
            if let view {
                addresses(view)
                if let access = view.access { line(access).accessibilityIdentifier("webhook.access") }
                if let secret { reveal(secret) }
                actions(view)
            } else if problem == nil {
                WorkingMark(label: "Reading the webhook")
            }
            if let problem {
                Text(problem).font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceTheme.StatusText.failed)
                    .accessibilityIdentifier("webhook.problem")
            }
        } header: { InsetHeader("Webhook") } footer: {
            if let view { senders(view) }
        }
        .insetRowBackground()
        .animation(.default, value: view)
        .animation(.default, value: secret == nil)
        .sensoryFeedback(.success, trigger: copies)
        .task(id: automationId) { await load() }
        .alert(confirm?.title ?? "", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
               presenting: confirming) { action in
            Button(confirm?.confirm ?? "", role: action == .revoke ? .destructive : nil) { Task { await send(action) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in Text(confirm?.body ?? "") }
    }

    private var confirm: AutomationWebhookView.Confirm? {
        switch confirming {
        case .rotate: view?.confirms.rotate
        case .revoke: view?.confirms.revoke
        case .create, nil: nil
        }
    }

    // MARK: Rows

    @ViewBuilder private func addresses(_ view: AutomationWebhookView) -> some View {
        if view.addresses.isEmpty, let gap = view.gap {
            line(gap).accessibilityIdentifier("webhook.gap")
        }
        ForEach(view.addresses) { address in
            HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.row) {
                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                    Text(address.name).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                    Text(address.url).font(AceDesign.Typeface.code).foregroundStyle(AceDesign.Ink.primary)
                        .textSelection(.enabled)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                copyButton(address.url, key: address.via, label: "Copy \(address.name) address")
            }
            .padding(.vertical, AceDesign.Space.tight)
            .accessibilityIdentifier("webhook.address.\(address.via)")
        }
    }

    private func reveal(_ secret: String) -> some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.row) {
                Text(secret).font(AceDesign.Typeface.code).foregroundStyle(AceDesign.Ink.primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("webhook.secret")
                // The secret stays on this phone's clipboard: never Handoff, and gone in five minutes.
                copyButton(secret, key: "secret", label: "Copy secret", localOnly: true)
            }
            if let note {
                Text(note).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
            }
            Button("Done") { self.secret = nil; self.note = nil }
                .buttonStyle(.rowAction)
                .accessibilityIdentifier("webhook.secretDone")
        }
        .padding(.vertical, AceDesign.Space.tight)
    }

    @ViewBuilder private func actions(_ view: AutomationWebhookView) -> some View {
        let disabled = pending || !model.canOperate
        if pending { WorkingMark(label: "Changing the secret") }
        if view.active {
            Button(view.confirms.rotate.confirm) { confirming = .rotate }
                .disabled(disabled)
                .accessibilityIdentifier("webhook.rotate")
            Button(view.confirms.revoke.confirm, role: .destructive) { confirming = .revoke }
                .disabled(disabled)
                .accessibilityIdentifier("webhook.revoke")
        } else {
            // A first secret replaces nothing, so it needs no confirm, as on the web. The bridge
            // refuses it if one was made elsewhere meanwhile, and the Rotate confirm opens.
            Button("Create secret") { Task { await send(.create) } }
                .disabled(disabled)
                .accessibilityIdentifier("webhook.create")
        }
    }

    private func senders(_ view: AutomationWebhookView) -> some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            Text("Senders sign with Standard Webhooks headers: \(view.headers.joined(separator: ", ")).")
            Text("In the prompt: " + view.variables.map { "\($0.name) for \($0.means)" }.joined(separator: ", ") + ".")
        }
        .accessibilityIdentifier("webhook.senders")
    }

    private func line(_ line: AutomationWebhookView.Line) -> some View {
        Text(line.text).font(AceDesign.Typeface.meta)
            .foregroundStyle(line.warn ? AceTheme.StatusText.needsYou : AceDesign.Ink.muted)
    }

    private func copyButton(_ text: String, key: String, label: String, localOnly: Bool = false) -> some View {
        Button {
            if localOnly {
                UIPasteboard.general.setItems([[UTType.plainText.identifier: text]],
                                              options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(300)])
            } else {
                UIPasteboard.general.string = text
            }
            copied = key
            copies += 1
            Task { try? await Task.sleep(for: .seconds(1.5)); if copied == key { copied = nil } }
        } label: {
            AceIcon(copied == key ? .check : .copy, size: AceDesign.Size.glyphMeta, relativeTo: .footnote)
                .foregroundStyle(AceDesign.Ink.muted)
                .frame(minWidth: AceDesign.Size.tap, minHeight: AceDesign.Size.tap)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(copied == key ? "Copied" : label)
    }

    // MARK: Bridge

    private var request: [String: Any] {
        ["automationId": automationId, "source": source]
    }

    private func load() async {
        var payload = request
        payload["type"] = "automations.webhook"
        do {
            let reply = try await model.service(payload, as: AutomationWebhookState.self)
            guard reply.ok, let webhook = reply.webhook else { problem = reply.error ?? "Couldn't read this webhook."; return }
            problem = nil
            view = webhook
        } catch { problem = error.localizedDescription }
    }

    private func send(_ action: Action) async {
        guard !pending else { return }
        pending = true
        defer { pending = false }
        var payload = request
        payload["type"] = "automations.webhook.secret"
        payload["action"] = action.rawValue
        do {
            let reply = try await model.service(payload, as: AutomationWebhookReply.self)
            if reply.exists == true, let webhook = reply.webhook {
                // A secret made elsewhere since this page read it: show it, then offer Rotate.
                view = webhook
                problem = reply.error
                confirming = .rotate
                return
            }
            guard reply.ok else { problem = reply.error ?? "Couldn't change the webhook's secret."; return }
            problem = nil
            if let webhook = reply.webhook { view = webhook }
            // A revoke leaves no secret to show; an older one shown here is dead too.
            secret = reply.secret
            note = reply.note
        } catch { problem = error.localizedDescription }
    }
}
