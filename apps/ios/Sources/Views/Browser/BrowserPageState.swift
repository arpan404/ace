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
                .background(AceDesign.Surface.background)
                .accessibilityIdentifier("browser.notice")
        }
    }

    private var content: AnyView? {
        guard let view = browser.view else { return AnyView(SkeletonPage(label: "Opening the browser")) }
        guard let state = view.state, !state.closed else {
            return AnyView(EmptyState(icon: .compass, title: "No page open") {
                if model.canOperate { Button("Open a page", action: openAddress).buttonStyle(.textAction()).frame(maxWidth: AceDesign.Size.loneAction) }
            })
        }
        if state.disconnected == true {
            return AnyView(EmptyState(icon: .warning, title: "The browser disconnected",
                                      line: state.reason ?? "Reopen it to continue where it left off.") {
                if model.canOperate { Button("Reopen") { model.browserReopen() }.buttonStyle(.textAction(.prominent)).frame(maxWidth: AceDesign.Size.loneAction) }
            })
        }
        if let certificate = state.certificate, let tabId = state.activeTabId {
            return AnyView(failure(certificate) {
                Button("Go back") { model.browserHistory("back") }.buttonStyle(.textAction(.prominent))
                Button("Open anyway (unsafe)") { model.browserProceed(tabId, url: certificate.url) }.buttonStyle(.textAction(.destructive))
            })
        }
        if let failure = state.failure {
            return AnyView(self.failure(failure) {
                Button("Reload") { model.browserHistory("reload") }.buttonStyle(.textAction(.prominent))
                    .accessibilityIdentifier("browser.failure.reload")
            })
        }
        if state.status != "ready" {
            return AnyView(EmptyState(icon: .compass, title: state.reason ?? "The browser is restarting…"))
        }
        if state.blank == true && !state.loading {
            return AnyView(EmptyState(icon: .compass, title: "New tab") {
                if model.canOperate { Button("Open a page", action: openAddress).buttonStyle(.textAction()).frame(maxWidth: AceDesign.Size.loneAction) }
            })
        }
        if browser.pageSize == nil { return AnyView(SkeletonPage(label: "Opening the page")) }
        return nil
    }

    /// A load that failed, said plainly, with the address it was for.
    private func failure<Actions: View>(_ failure: BrowserViewInfo.Failure, @ViewBuilder actions: () -> Actions) -> some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            AceIcon(.warning, size: AceDesign.Size.emptyIcon, relativeTo: .title).foregroundStyle(AceDesign.Ink.muted)
                .padding(.bottom, AceDesign.Space.related)
            Text(failure.title).font(AceDesign.Typeface.title.weight(AceDesign.Typeface.strong))
            Text(failure.host).font(AceDesign.Typeface.body).foregroundStyle(AceDesign.Ink.muted)
            Text(failure.detail).font(AceDesign.Typeface.title).foregroundStyle(AceDesign.Ink.muted)
            VStack(spacing: AceDesign.Space.related) { actions() }
                .padding(.top, AceDesign.Space.margin)
                .disabled(!model.canOperate)
        }
        .padding(AceDesign.Space.margin)
        .frame(maxWidth: AceDesign.Size.noticeWidth, maxHeight: .infinity, alignment: .topLeading)
        .padding(.top, AceDesign.Space.section)
        .accessibilityElement(children: .contain)
    }
}
