// SPDX-License-Identifier: Apache-2.0
//! `pdf-svg.ts`'s painter: a page's drawing as SVG elements.

use super::pdf_lexer::{PdfDict, PdfLexer, PdfValue, Token};
use super::pdf_objects::{PdfDocument, name_of, numbers_of, resolve, stream_text};
use super::pdf_style::{CAPS, JOINS, State, color, matrix_text, multiply, point, round, saved};

/// Skips tokens up to and including `end`, the way the painter steps over text and images.
fn skip_to(lexer: &mut PdfLexer<'_>, end: &str) {
    while let Some(next) = lexer.next_token() {
        if matches!(&next, Token::Keyword(word) if word == end) {
            break;
        }
    }
}

/// Interprets one page's drawing (and the forms it draws) into SVG elements.
pub struct Painter<'a> {
    out: Vec<String>,
    defs: Vec<String>,
    painted: usize,
    clips: usize,
    prefix: &'a str,
    objects: &'a PdfDocument,
    depth: usize,
}

impl<'a> Painter<'a> {
    pub fn new(objects: &'a PdfDocument, prefix: &'a str) -> Self {
        Self {
            out: Vec::new(),
            defs: Vec::new(),
            painted: 0,
            clips: 0,
            prefix,
            objects,
            depth: 0,
        }
    }

    pub fn elements(&self) -> (&[String], &[String], usize) {
        (&self.out, &self.defs, self.painted)
    }

    fn resource(
        &self,
        resources: Option<&'a PdfDict>,
        group: &str,
        name: Option<&str>,
    ) -> Option<&'a PdfValue> {
        let dict = resolve(self.objects, resources.and_then(|dict| dict.get(group)));
        let name = name?;
        match dict {
            Some(PdfValue::Dict(dict)) => resolve(self.objects, dict.get(name)),
            _ => None,
        }
    }

    pub fn run(&mut self, content: &str, resources: Option<&'a PdfDict>, start: &State) {
        let chars: Vec<char> = content.chars().collect();
        let mut lexer = PdfLexer::new(&chars, 0);
        let mut stack: Vec<State> = Vec::new();
        let mut state = saved(start);
        let mut path: Vec<String> = Vec::new();
        let mut current = (0.0, 0.0);
        let mut subpath = (0.0, 0.0);
        let mut clip: Option<&'static str> = None;
        let mut operands: Vec<PdfValue> = Vec::new();
        while let Some(token) = lexer.next_token() {
            let keyword = match token {
                Token::Value(value) => {
                    operands.push(value);
                    if operands.len() > 64 {
                        let cut = operands.len() - 64;
                        operands.drain(..cut);
                    }
                    continue;
                }
                Token::Keyword(keyword) => keyword,
            };
            let num = |index: usize| -> f64 {
                operands
                    .len()
                    .checked_sub(1 + index)
                    .and_then(|at| operands.get(at))
                    .and_then(PdfValue::as_number)
                    .unwrap_or(0.0)
            };
            match keyword.as_str() {
                "q" => {
                    stack.push(state.clone());
                    state = saved(&state);
                }
                "Q" => {
                    self.out.push("</g>".repeat(state.opened));
                    state = stack.pop().unwrap_or(state);
                }
                "cm" => {
                    state.ctm =
                        multiply([num(5), num(4), num(3), num(2), num(1), num(0)], state.ctm);
                }
                "m" => {
                    path.push(format!("M{}", point(num(1), num(0))));
                    current = (num(1), num(0));
                    subpath = current;
                }
                "l" => {
                    path.push(format!("L{}", point(num(1), num(0))));
                    current = (num(1), num(0));
                }
                "c" => {
                    path.push(format!(
                        "C{} {} {}",
                        point(num(5), num(4)),
                        point(num(3), num(2)),
                        point(num(1), num(0))
                    ));
                    current = (num(1), num(0));
                }
                "v" => {
                    path.push(format!(
                        "C{} {} {}",
                        point(current.0, current.1),
                        point(num(3), num(2)),
                        point(num(1), num(0))
                    ));
                    current = (num(1), num(0));
                }
                "y" => {
                    path.push(format!(
                        "C{} {} {}",
                        point(num(3), num(2)),
                        point(num(1), num(0)),
                        point(num(1), num(0))
                    ));
                    current = (num(1), num(0));
                }
                "h" => {
                    path.push("Z".to_string());
                    current = subpath;
                }
                "re" => {
                    let (x, y, w, h) = (num(3), num(2), num(1), num(0));
                    path.push(format!(
                        "M{}h{}v{}h{}Z",
                        point(x, y),
                        round(w),
                        round(h),
                        round(-w)
                    ));
                    current = (x, y);
                    subpath = current;
                }
                "W" => clip = Some("nonzero"),
                "W*" => clip = Some("evenodd"),
                "n" => self.paint(&mut path, &mut clip, &mut state, None, false),
                "f" | "F" => self.paint(&mut path, &mut clip, &mut state, Some("nonzero"), false),
                "f*" => self.paint(&mut path, &mut clip, &mut state, Some("evenodd"), false),
                "S" => self.paint(&mut path, &mut clip, &mut state, None, true),
                "s" => {
                    path.push("Z".to_string());
                    self.paint(&mut path, &mut clip, &mut state, None, true);
                }
                "B" => self.paint(&mut path, &mut clip, &mut state, Some("nonzero"), true),
                "B*" => self.paint(&mut path, &mut clip, &mut state, Some("evenodd"), true),
                "b" | "b*" => {
                    path.push("Z".to_string());
                    let fill = if keyword == "b" { "nonzero" } else { "evenodd" };
                    self.paint(&mut path, &mut clip, &mut state, Some(fill), true);
                }
                "w" => state.line_width = num(0),
                "J" => state.cap = num(0) as usize,
                "j" => state.join = num(0) as usize,
                "M" => state.miter = num(0),
                "d" => {
                    let dashes = match operands.len().checked_sub(2) {
                        Some(at) => numbers_of(operands.get(at)),
                        None => Vec::new(),
                    };
                    state.dash = if dashes.is_empty() {
                        None
                    } else {
                        Some(
                            dashes
                                .iter()
                                .map(|value| round(*value))
                                .collect::<Vec<String>>()
                                .join(" "),
                        )
                    };
                }
                "cs" | "CS" => {
                    let name = name_of(operands.last());
                    let space = self.resource(resources, "ColorSpace", name);
                    let space = resolve(self.objects, space);
                    let icc = match space {
                        Some(PdfValue::Array(items)) => resolve(self.objects, items.get(1)),
                        _ => None,
                    };
                    let components = match name {
                        Some("DeviceGray") | Some("CalGray") => 1,
                        Some("DeviceCMYK") => 4,
                        _ => match icc {
                            Some(PdfValue::Dict(dict)) => match dict.get("N") {
                                Some(PdfValue::Number(n)) => *n as usize,
                                _ => 3,
                            },
                            _ => 3,
                        },
                    };
                    let initial = color(if components == 4 {
                        &[0.0, 0.0, 0.0, 1.0]
                    } else {
                        &[0.0]
                    });
                    if keyword == "cs" {
                        state.fill_components = components;
                        state.fill = initial;
                    } else {
                        state.stroke_components = components;
                        state.stroke = initial;
                    }
                }
                "sc" | "scn" => {
                    let values: Vec<f64> =
                        operands.iter().filter_map(PdfValue::as_number).collect();
                    if !values.is_empty() {
                        let at = values.len().saturating_sub(state.fill_components);
                        state.fill = color(&values[at..]);
                    }
                }
                "SC" | "SCN" => {
                    let values: Vec<f64> =
                        operands.iter().filter_map(PdfValue::as_number).collect();
                    if !values.is_empty() {
                        let at = values.len().saturating_sub(state.stroke_components);
                        state.stroke = color(&values[at..]);
                    }
                }
                "g" => {
                    state.fill = color(&[num(0)]);
                    state.fill_components = 1;
                }
                "G" => {
                    state.stroke = color(&[num(0)]);
                    state.stroke_components = 1;
                }
                "rg" => {
                    state.fill = color(&[num(2), num(1), num(0)]);
                    state.fill_components = 3;
                }
                "RG" => {
                    state.stroke = color(&[num(2), num(1), num(0)]);
                    state.stroke_components = 3;
                }
                "k" => {
                    state.fill = color(&[num(3), num(2), num(1), num(0)]);
                    state.fill_components = 4;
                }
                "K" => {
                    state.stroke = color(&[num(3), num(2), num(1), num(0)]);
                    state.stroke_components = 4;
                }
                "gs" => {
                    let graphics = self.resource(resources, "ExtGState", name_of(operands.last()));
                    if let Some(PdfValue::Dict(graphics)) = graphics {
                        if let Some(PdfValue::Number(value)) = graphics.get("ca") {
                            state.fill_alpha = *value;
                        }
                        if let Some(PdfValue::Number(value)) = graphics.get("CA") {
                            state.stroke_alpha = *value;
                        }
                        if let Some(PdfValue::Number(value)) = graphics.get("LW") {
                            state.line_width = *value;
                        }
                    }
                }
                "Do" => {
                    let form = self.resource(resources, "XObject", name_of(operands.last()));
                    let Some(PdfValue::Dict(form)) = form else {
                        operands.clear();
                        continue;
                    };
                    if name_of(form.get("Subtype")) != Some("Form") || self.depth > 8 {
                        operands.clear();
                        continue;
                    }
                    let matrix = numbers_of(form.get("Matrix"));
                    let own = resolve(self.objects, form.get("Resources"));
                    self.depth += 1;
                    let nested: Option<&PdfDict> = match own {
                        Some(PdfValue::Dict(dict)) => Some(dict),
                        _ => resources,
                    };
                    let content = stream_text(form);
                    let nested_start = match matrix.len() == 6 {
                        true => State {
                            ctm: multiply(
                                [
                                    matrix[0], matrix[1], matrix[2], matrix[3], matrix[4],
                                    matrix[5],
                                ],
                                state.ctm,
                            ),
                            ..state.clone()
                        },
                        false => saved(&state),
                    };
                    self.run(&content, nested, &nested_start);
                    self.depth -= 1;
                }
                // Text and inline images never appear in device art; skip to their end.
                "BT" => skip_to(&mut lexer, "ET"),
                "BI" => skip_to(&mut lexer, "EI"),
                _ => {}
            }
            operands.clear();
        }
        self.out.push("</g>".repeat(state.opened));
        while let Some(open) = stack.pop() {
            self.out.push("</g>".repeat(open.opened));
        }
    }

    fn paint(
        &mut self,
        path: &mut Vec<String>,
        clip: &mut Option<&'static str>,
        state: &mut State,
        fill: Option<&'static str>,
        stroke: bool,
    ) {
        if !path.is_empty() && (fill.is_some() || stroke) {
            let mut attributes = vec![
                format!("d=\"{}\"", path.join("")),
                format!("transform=\"matrix({})\"", matrix_text(state.ctm)),
            ];
            match fill {
                Some(_) => attributes.push(format!("fill=\"{}\"", state.fill)),
                None => attributes.push("fill=\"none\"".to_string()),
            }
            if fill == Some("evenodd") {
                attributes.push("fill-rule=\"evenodd\"".to_string());
            }
            if fill.is_some() && state.fill_alpha < 1.0 {
                attributes.push(format!("fill-opacity=\"{}\"", round(state.fill_alpha)));
            }
            if stroke {
                attributes.push(format!("stroke=\"{}\"", state.stroke));
                attributes.push(format!(
                    "stroke-width=\"{}\"",
                    round(if state.line_width == 0.0 {
                        1.0
                    } else {
                        state.line_width
                    })
                ));
                attributes.push(format!(
                    "stroke-linecap=\"{}\"",
                    CAPS.get(state.cap).copied().unwrap_or("butt")
                ));
                attributes.push(format!(
                    "stroke-linejoin=\"{}\"",
                    JOINS.get(state.join).copied().unwrap_or("miter")
                ));
                attributes.push(format!(
                    "stroke-miterlimit=\"{}\"",
                    round(state.miter.max(1.0))
                ));
                if let Some(dash) = &state.dash {
                    attributes.push(format!("stroke-dasharray=\"{dash}\""));
                }
                if state.stroke_alpha < 1.0 {
                    attributes.push(format!("stroke-opacity=\"{}\"", round(state.stroke_alpha)));
                }
            }
            self.out.push(format!("<path {}/>", attributes.join(" ")));
            self.painted += 1;
        }
        if let Some(rule) = *clip
            && !path.is_empty()
        {
            {
                let id = format!("{}c{}", self.prefix, self.clips);
                self.clips += 1;
                self.defs.push(format!(
                    "<clipPath id=\"{id}\"><path d=\"{}\" transform=\"matrix({})\" clip-rule=\"{rule}\"/></clipPath>",
                    path.join(""),
                    matrix_text(state.ctm)
                ));
                self.out.push(format!("<g clip-path=\"url(#{id})\">"));
                state.opened += 1;
            }
        }
        path.clear();
        *clip = None;
    }
}
