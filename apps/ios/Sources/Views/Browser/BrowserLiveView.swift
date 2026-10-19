import SwiftUI

/// The thread's browser, live (#1061): the agent's own tab on its machine, watched as video and
/// driven by touch, the keyboard and native pickers. A browser request the agent is waiting on
/// can be finished here, then answered Done as on its card.
struct BrowserLiveView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Bindable var model: ClientModel
    /// The thread's open browser request, if the agent asked the person for help.
    let help: ApprovalRow?
    let answerHelp: ([String: Any]) -> Void
    @State private var keyboardRequest = 0
    /// The picker the person already answered, until the page closes it.
    @State private var answeredPicker: String?

    private var browser: BrowserLiveModel { model.browser }
    private var state: BrowserViewInfo.State? { browser.view?.state }

    var body: some View {
        NavigationStack {
            GeometryReader { proxy in
                ZStack {
                    BrowserSurface(model: model, keyboardRequest: keyboardRequest)
                    if let tooltip = browser.page?.tooltip, let page = browser.pageSize {
                        let box = PageGeometry(view: proxy.size, page: page).viewRect(PageRect(x: tooltip.x, y: tooltip.y, width: 0, height: 0))
                        Text(tooltip.text)
                            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .padding(AceTheme.Spacing.xs)
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: AceTheme.Radii.button))
                            .fixedSize()
                            .position(x: min(max(box.minX, 80), proxy.size.width - 80), y: box.minY + 24)
                            .allowsHitTesting(false)
                    }
                    if let notice { notice.allowsHitTesting(false) }
                }
            }
            .ignoresSafeArea(.keyboard)
            .background(AceTheme.Colours.secondaryBackground)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }.accessibilityIdentifier("browser.close")
                }
                ToolbarItem(placement: .principal) { header }
                ToolbarItem(placement: .primaryAction) { menu }
            }
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { helpStrip }
            .sheet(item: Binding(get: { openPicker }, set: { _ in })) { picker in
                BrowserPickerSheet(picker: picker) { values in
                    answeredPicker = picker.pickerId
                    model.browserInput([.pick(pickerId: picker.pickerId, values: values)])
                }
                .onDisappear {
                    // Swiped away: the page's picker closes unchanged, unless the page already did.
                    guard answeredPicker != picker.pickerId, browser.page?.picker?.pickerId == picker.pickerId else { return }
                    answeredPicker = picker.pickerId
                    model.browserInput([.pick(pickerId: picker.pickerId, values: nil)])
                }
            }
        }
        .onChange(of: scenePhase, initial: true) { _, phase in browser.setVisible(phase == .active) }
        .onDisappear { model.closeBrowser() }
    }

    private var openPicker: BrowserPageInfo.Picker? {
        guard model.canOperate, let picker = browser.page?.picker, picker.pickerId != answeredPicker else { return nil }
        return picker
    }

    private var header: some View {
        let tab = state?.tabs.first { $0.id == state?.activeTabId }
        return VStack(spacing: AceTheme.Spacing.none) {
            Text(tab?.title ?? "Browser").aceFont(AceTheme.Typography.label, relativeTo: .subheadline).lineLimit(1)
            Text(Self.host(state?.url ?? "")).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("browser.header")
    }

    private var menu: some View {
        Menu {
            if model.canOperate {
                if browser.page?.focus != nil {
                    Button("Keyboard", systemImage: "keyboard") { keyboardRequest += 1 }
                }
                Button("Back", systemImage: "chevron.backward") { model.browserHistory("back") }
                Button("Forward", systemImage: "chevron.forward") { model.browserHistory("forward") }
                if state?.loading == true {
                    Button("Stop", systemImage: "xmark") { model.browserHistory("stop") }
                } else {
                    Button("Reload", systemImage: "arrow.clockwise") { model.browserHistory("reload") }
                }
                if let tabs = state?.tabs, tabs.count > 1 {
                    Section("Tabs") {
                        ForEach(tabs) { tab in
                            Button { model.browserSelectTab(tab.id) } label: {
                                if tab.id == state?.activeTabId { Label(tab.title, systemImage: "checkmark") } else { Text(tab.title) }
                            }
                        }
                        if let more = state?.moreTabs, more > 0 { Text("\(more) more on your computer") }
                    }
                }
            } else {
                Text("View only")
            }
        } label: { Image(systemName: "ellipsis.circle") }
        .accessibilityLabel("Browser options")
        .accessibilityIdentifier("browser.menu")
    }

    /// What stands between the person and a live page, if anything.
    private var notice: AnyView? {
        let message: String?
        if browser.view?.error != nil, state == nil {
            message = "No browser is open for this thread yet. It shows here once the agent opens one."
        } else if state?.closed == true {
            message = "The browser is closed."
        } else if let state, state.status != "ready" {
            message = state.reason ?? "The browser is restarting…"
        } else if let error = state?.loadError {
            message = error
        } else {
            message = nil
        }
        if let message {
            return AnyView(Text(message)
                .aceFont(AceTheme.Typography.body, relativeTo: .body)
                .multilineTextAlignment(.center)
                .padding(AceTheme.Spacing.lg)
                .floatingGlass()
                .padding(AceTheme.Spacing.xl)
                .accessibilityIdentifier("browser.notice"))
        }
        if browser.pageSize == nil { return AnyView(ProgressView("Connecting to the browser…")) }
        return nil
    }

    @ViewBuilder private var helpStrip: some View {
        if let help, help.state == "pending" {
            let submission = model.approvalSubmissions[help.id]
            HStack(spacing: AceTheme.Spacing.md) {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text(help.help?.title ?? "The agent needs you in this tab")
                        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).lineLimit(2)
                    Text("Say Done when you've finished.").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                }
                Spacer()
                CardButton(title: "Done", primary: true) {
                    answerHelp(["kind": "help", "outcome": "done"])
                    dismiss()
                }
                .frame(maxWidth: 120)
                .disabled(submission != nil || !model.canOperate)
                .accessibilityIdentifier("browser.help.done")
            }
            .padding(AceTheme.Spacing.lg)
            .floatingGlass()
            .padding(.horizontal, AceTheme.Dimensions.composerInset).padding(.bottom, AceTheme.Spacing.sm)
        }
    }

    private static func host(_ url: String) -> String {
        URLComponents(string: url)?.host ?? url
    }
}

extension BrowserPageInfo.Picker: Identifiable { var id: String { pickerId } }
