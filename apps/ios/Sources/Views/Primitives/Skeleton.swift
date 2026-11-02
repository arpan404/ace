import SwiftUI

/// Loading, everywhere the same (DESIGN.md §3 "Loading"): still pills in the shape of what is
/// coming, never a page spinner, never moving. Rows are three lines (a meta line, the title, a
/// meta line); a page is a title and a few lines of text. On the page gutter.
struct SkeletonRows: View {
    // Bar widths and heights trace the lines they stand in for (meta, title, meta): content geometry.
    var count = 5
    var label = "Loading"
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.group) {
            ForEach(0..<count, id: \.self) { index in
                VStack(alignment: .leading, spacing: AceDesign.Space.related) {
                    SkeletonBar(width: 104, height: 11)
                    SkeletonBar(width: index.isMultiple(of: 2) ? 236 : 188, height: 15)
                    SkeletonBar(width: 136, height: 11)
                }
            }
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .padding(.vertical, AceDesign.Space.row)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }
}

/// A page while it reads: a heading and a few lines of prose.
struct SkeletonPage: View {
    // A heading's bar, then body lines: the text's own measure.
    var label = "Loading"
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.row) {
            SkeletonBar(width: 220, height: 20)
            ForEach(0..<5, id: \.self) { index in
                SkeletonBar(width: index == 4 ? 180 : nil, height: 13)
            }
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .padding(.vertical, AceDesign.Space.margin)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }
}

/// One still pill; `nil` width fills the line.
struct SkeletonBar: View {
    var width: CGFloat?
    let height: CGFloat
    var body: some View {
        AceDesign.Shape.control.fill(AceDesign.Surface.fill)
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
    }
}
