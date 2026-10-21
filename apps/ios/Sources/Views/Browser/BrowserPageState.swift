import SwiftUI

/// What shows in place of the live page when there is none to show: no browser yet, a blank tab,
/// a failed load (with Reload), an untrusted certificate, a browser that lost its pages (with
/// Reopen), one restarting, or the first picture on its way. Nothing while the page shows.
struct BrowserPageState: View {
    @Bindable var model: ClientModel
    let openAddress: () -> Void
    private var browser: BrowserLiveModel { model.browser }
    private var state: BrowserViewInfo.State? { browser.view?.state }

    var body: some View {
        if let content {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(AceTheme.Colours.background)
                .accessibilityIdentifier("browser.notice")
        }
    }

    private var content: AnyView? {
        guard let view = browser.view else { return AnyView(ProgressView("Opening the browser…")) }
        guard let state = view.state, !state.closed else {
            return AnyView(ContentUnavailableView {
                Label("No page open", systemImage: "safari")
            } actions: {
                if model.canOperate { Button("Open a page", action: openAddress).buttonStyle(.pillSecondary).frame(maxWidth: 200) }
            })
        }
        if state.disconnected == true {
            return AnyView(ContentUnavailableView {
                Label("The browser disconnected", systemImage: "exclamationmark.triangle")
            } description: {
                Text(state.reason ?? "Reopen it to continue where it left off.")
            } actions: {
                if model.canOperate { Button("Reopen") { model.browserReopen() }.buttonStyle(.pillPrimary).frame(maxWidth: 200) }
            })
        }
        if let certificate = state.certificate, let tabId = state.activeTabId {
            return AnyView(failure(certificate) {
                Button("Go back") { model.browserHistory("back") }.buttonStyle(.pillPrimary)
                Button("Open anyway (unsafe)") { model.browserProceed(tabId, url: certificate.url) }.buttonStyle(.pillRefuse)
            })
        }
        if let failure = state.failure {
            return AnyView(self.failure(failure) {
                Button("Reload") { model.browserHistory("reload") }.buttonStyle(.pillPrimary)
                    .accessibilityIdentifier("browser.failure.reload")
            })
        }
        if state.status != "ready" {
            return AnyView(ProgressView(state.reason ?? "The browser is restarting…").padding(AceTheme.Spacing.xl))
        }
        if state.blank == true && !state.loading {
            return AnyView(ContentUnavailableView {
                Label("New tab", systemImage: "safari")
            } actions: {
                if model.canOperate { Button("Open a page", action: openAddress).buttonStyle(.pillSecondary).frame(maxWidth: 200) }
            })
        }
        if browser.pageSize == nil { return AnyView(ProgressView("Opening the page…")) }
        return nil
    }

    /// A load that failed, said plainly, with the address it was for.
    private func failure<Actions: View>(_ failure: BrowserViewInfo.Failure, @ViewBuilder actions: () -> Actions) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 30)).foregroundStyle(AceTheme.Colours.mutedForeground)
                .padding(.bottom, AceTheme.Spacing.sm)
            Text(failure.title).aceFont(AceTheme.Typography.title, relativeTo: .title3)
            Text(failure.host).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).foregroundStyle(AceTheme.Colours.mutedForeground)
            Text(failure.detail).aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.mutedForeground)
            VStack(spacing: AceTheme.Spacing.sm) { actions() }
                .padding(.top, AceTheme.Spacing.lg)
                .disabled(!model.canOperate)
        }
        .padding(AceTheme.Spacing.xxl)
        .frame(maxWidth: 480, maxHeight: .infinity, alignment: .topLeading)
        .padding(.top, AceTheme.Spacing.xxxl)
        .accessibilityElement(children: .contain)
    }
}
