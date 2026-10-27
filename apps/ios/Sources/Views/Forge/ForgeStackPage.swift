import SwiftUI

/// A pull request's stack as a page (the web's stack rail and toolbar): its layers in order from
/// the trunk, this one marked; the operation in flight and layers GitHub moved; then the
/// controls in words, each saying why when it can't run. A change shows what it will do (the
/// layers, the method, old → new revisions) and runs only once confirmed, pinned to the stack
/// as shown, through a linked thread's checkout. Aborting is red. The stack is read again after.
struct ForgeStackPageView: View {
    let client: ClientModel
    let route: ForgeRoute
    let open: (ForgeRoute) -> Void
    @AppStorage("ace.git.mergeMethod") private var savedMethod = ""
    @State private var threadId: String?
    @State private var page: ForgeStackPage?
    @State private var failure: String?
    @State private var writing = false
    @State private var outcome: ForgeWorkOutcome?
    @State private var confirming: ForgeStackPage.Control?

    private var method: String { savedMethod.isEmpty ? "squash" : savedMethod }
    private var request: [String: Any] { ClientModel.forgeStackRead(route, threadId: threadId, method: method) }
    private static let methods = [("squash", "Squash"), ("merge", "Merge commit"), ("rebase", "Rebase")]

    var body: some View {
        ScrollView {
            if let page { content(page).transition(.opacity) }
            else if let failure {
                EmptyState(icon: nil, title: "Couldn't read the stack", line: failure, failed: true) {
                    Button("Try again") { Task { await load(fresh: true) } }
                }
                .padding(.top, 120)
            } else {
                ProgressView().padding(.top, 120).frame(maxWidth: .infinity)
            }
        }
        .animation(.smooth, value: page)
        .background(AceTheme.Colours.background)
        .refreshable { await load(fresh: true) }
        .navigationTitle(page?.stack.map { "Stack #\($0.number)" } ?? "Stack")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: "\(threadId ?? "")|\(method)|\(client.readGeneration(request))") { await load(fresh: false) }
        .sensoryFeedback(.success, trigger: outcome) { _, now in now?.ok == true }
        .sheet(item: $confirming) { control in confirmSheet(control) }
        // A refresh that changes what a control would do ends the question asked against the old one.
        .onChange(of: page) { _, now in
            if let asked = confirming, now?.controls.first(where: { $0.action == asked.action })?.confirm != asked.confirm { confirming = nil }
        }
    }

    @ViewBuilder private func content(_ page: ForgeStackPage) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.lg) {
            if let stack = page.stack {
                ForgeSection(title: "Layers onto \(stack.trunk)") {
                    ForEach(stack.layers, id: \.number) { layer in layerRow(layer) }
                }
            } else {
                Text("This pull request isn't part of a stack.").meta().padding(.horizontal, AceTheme.Spacing.lg)
            }
            if let operation = page.operation {
                Text(operation.label).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .foregroundStyle(operation.tone == "failed" ? AceTone.failed.text : AceTheme.Colours.foreground)
                    .padding(.horizontal, AceTheme.Spacing.lg)
                    .accessibilityIdentifier("forge.stack.operation")
            }
            if !page.moved.isEmpty {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text("Moved on GitHub since review").aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTone.needsYou.text)
                    ForEach(page.moved, id: \.self) { Text($0).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote) }
                }
                .padding(.horizontal, AceTheme.Spacing.lg)
            }
            if let note = page.note { Text(note).meta().padding(.horizontal, AceTheme.Spacing.lg) }
            ForgeOutcomeLine(outcome: outcome, identifier: "forge.stack.outcome")
            if page.stack != nil, client.canOperate { controls(page) }
        }
        .padding(.vertical, AceTheme.Spacing.md)
    }

    private func layerRow(_ layer: ForgeStackPage.Layer) -> some View {
        Button {
            guard !layer.current else { return }
            open(ForgeRoute(kind: .pull, machineId: route.machineId, project: route.project, number: layer.number, repository: route.repository))
        } label: {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                HStack(spacing: AceTheme.Spacing.sm) {
                    Text(verbatim: "#\(layer.number)").monospacedDigit().meta(AceTheme.Colours.subtleForeground)
                    Text(layer.title).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                        .fontWeight(layer.current ? .semibold : .regular)
                        .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                    Spacer(minLength: AceTheme.Spacing.sm)
                    Text(layer.state).meta()
                }
                HStack(spacing: AceTheme.Spacing.sm) {
                    signal(layer.checks)
                    signal(layer.review)
                    if layer.merge.blocked { Text(layer.merge.label).meta(AceTone.failed.text) }
                }
            }
            .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
            .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.row)
        .accessibilityIdentifier("forge.stack.layer.\(layer.number)")
    }

    private func signal(_ signal: ForgeStackPage.Signal) -> some View {
        Text(signal.label).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(signal.tone == "failed" ? AceTone.failed.text : AceTheme.Colours.mutedForeground)
    }

    @ViewBuilder private func controls(_ page: ForgeStackPage) -> some View {
        ForgeSection(title: "Change the stack") {
            ForgeThreadPicker(threads: page.threads, chosen: page.threadId) { threadId = $0 }
            HStack {
                Text("Merge method").aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                Spacer(minLength: AceTheme.Spacing.sm)
                Menu {
                    Picker("Merge method", selection: Binding(get: { method }, set: { savedMethod = $0 })) {
                        ForEach(Self.methods, id: \.0) { Text($0.1).tag($0.0) }
                    }
                } label: { Text(Self.methods.first { $0.0 == method }?.1 ?? method).meta() }
                    .accessibilityIdentifier("forge.stack.method")
            }
            .padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: 44)
            ForEach(page.controls) { control in
                ForgeTextAction(label: control.label, destructive: control.destructive, reason: control.reason,
                                busy: writing && confirming?.action == control.action, identifier: "forge.stack.\(control.action)") {
                    confirming = control
                }
                .padding(.vertical, AceTheme.Spacing.xxs)
            }
        }
    }

    private func confirmSheet(_ control: ForgeStackPage.Control) -> some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
                    if let confirm = control.confirm {
                        Text(confirm.text).aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                        ForEach(confirm.lines, id: \.self) { Text($0).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote) }
                        if !confirm.ready { Text("There is nothing for it to change.").meta() }
                    }
                }
                .padding(AceTheme.Spacing.lg).frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(control.label).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { confirming = nil } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(control.confirm?.button ?? "Confirm", role: control.destructive ? .destructive : nil) { run(control) }
                        .disabled(writing || control.confirm?.ready != true)
                        .accessibilityIdentifier("forge.stack.confirm")
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func run(_ control: ForgeStackPage.Control) {
        guard !writing, let review = control.confirm?.review, let threadId = page?.threadId, let repository = route.repository else { return }
        writing = true
        Task {
            outcome = await client.forgeWorkWrite(["type": "forge.stack", "project": route.project, "number": route.number,
                                                    "repository": repository.json, "threadId": threadId, "action": control.action,
                                                    "method": method, "review": review])
            confirming = nil
            await load(fresh: true)
            writing = false
        }
    }

    private func load(fresh: Bool) async {
        do {
            page = try await client.forgeWorkRead(request, fresh: fresh, as: ForgeStackPage.self)
            failure = nil
        }
        catch is CancellationError {}
        catch { if page == nil { failure = error.localizedDescription } }
    }
}
