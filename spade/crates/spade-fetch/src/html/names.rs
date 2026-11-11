//! Which HTML elements do what, as lists of names.

/// HTML start tags that end SVG or MathML content, as the HTML standard lists them.
pub fn breaks_out_of_foreign(name: &str, attrs: &[(&str, &str)]) -> bool {
    matches!(
        name,
        "b" | "big"
            | "blockquote"
            | "body"
            | "br"
            | "center"
            | "code"
            | "dd"
            | "div"
            | "dl"
            | "dt"
            | "em"
            | "embed"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "head"
            | "hr"
            | "i"
            | "img"
            | "li"
            | "listing"
            | "menu"
            | "meta"
            | "nobr"
            | "ol"
            | "p"
            | "pre"
            | "ruby"
            | "s"
            | "small"
            | "span"
            | "strong"
            | "strike"
            | "sub"
            | "sup"
            | "table"
            | "tt"
            | "u"
            | "ul"
            | "var"
    ) || (name == "font"
        && attrs
            .iter()
            .any(|(k, _)| matches!(*k, "color" | "face" | "size")))
}

/// SVG and MathML elements whose children are HTML again.
/// These are the HTML integration points (SVG `foreignObject`, `desc` and `title`, and MathML
/// `annotation-xml` declaring HTML) and the MathML text integration points.
pub fn html_inside(name: &str, attrs: &[(&str, &str)]) -> bool {
    match name {
        "foreignobject" | "desc" | "title" | "mi" | "mo" | "mn" | "ms" | "mtext" => true,
        "annotation-xml" => attrs.iter().any(|(k, v)| {
            *k == "encoding"
                && (v.eq_ignore_ascii_case("text/html")
                    || v.eq_ignore_ascii_case("application/xhtml+xml"))
        }),
        _ => false,
    }
}

/// Elements whose content is never page text. A form's or button's text is kept; only the
/// controls inside a form are dropped.
pub fn left_out(name: &str) -> bool {
    matches!(
        name,
        "head"
            | "title"
            | "script"
            | "style"
            | "noscript"
            | "template"
            | "nav"
            | "aside"
            | "input"
            | "datalist"
            | "select"
            | "textarea"
            | "svg"
            | "math"
            | "canvas"
            | "iframe"
            | "object"
            | "embed"
            | "noembed"
            | "noframes"
            | "xmp"
            | "plaintext"
    )
}

pub fn is_void(name: &str) -> bool {
    matches!(
        name,
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "source"
            | "track"
            | "wbr"
            | "param"
            | "keygen"
    )
}

pub fn is_heading(name: &str) -> bool {
    matches!(name, "h1" | "h2" | "h3" | "h4" | "h5" | "h6")
}

/// Elements that may sit in `<head>`; anything else ends it.
pub fn head_content(name: &str) -> bool {
    matches!(
        name,
        "head" | "title" | "meta" | "link" | "base" | "style" | "script" | "noscript" | "template"
    )
}

pub fn closes_p(name: &str) -> bool {
    is_heading(name)
        || matches!(
            name,
            "address"
                | "article"
                | "aside"
                | "blockquote"
                | "details"
                | "dialog"
                | "div"
                | "dl"
                | "dd"
                | "dt"
                | "fieldset"
                | "figcaption"
                | "figure"
                | "footer"
                | "form"
                | "header"
                | "hgroup"
                | "hr"
                | "li"
                | "main"
                | "menu"
                | "nav"
                | "ol"
                | "p"
                | "pre"
                | "section"
                | "summary"
                | "table"
                | "ul"
        )
}
