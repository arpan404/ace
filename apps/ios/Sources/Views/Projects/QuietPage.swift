import SwiftUI

/// Page-local adapters keep native fields and menus within the shared cardless groups.
struct QuietPage<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AceDesign.Space.group) { content() }
                .padding(.vertical, AceDesign.Space.related)
        }
        .background(AceDesign.Surface.background)
        .buttonStyle(.textAction())
    }
}

struct QuietGroup<Content: View, Header: View, Footer: View>: View {
    let content: () -> Content
    let header: () -> Header
    let footer: () -> Footer
    init(@ViewBuilder content: @escaping () -> Content, @ViewBuilder header: @escaping () -> Header, @ViewBuilder footer: @escaping () -> Footer) {
        self.content = content; self.header = header; self.footer = footer
    }
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            header().font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.subtle)
                .padding(.horizontal, AceDesign.Space.margin)
            QuietSection {
                Group(subviews: content()) { rows in
                    ForEach(rows) { row in QuietSectionRow { row } }
                }
            }
            footer().font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                .padding(.horizontal, AceDesign.Space.margin)
        }
    }
}
extension QuietGroup where Header == EmptyView {
    init(@ViewBuilder content: @escaping () -> Content, @ViewBuilder footer: @escaping () -> Footer) {
        self.init(content: content, header: { EmptyView() }, footer: footer)
    }
}
extension QuietGroup where Footer == EmptyView {
    init(@ViewBuilder content: @escaping () -> Content, @ViewBuilder header: @escaping () -> Header) {
        self.init(content: content, header: header, footer: { EmptyView() })
    }
}
extension QuietGroup where Header == EmptyView, Footer == EmptyView {
    init(@ViewBuilder content: @escaping () -> Content) {
        self.init(content: content, header: { EmptyView() }, footer: { EmptyView() })
    }
}
