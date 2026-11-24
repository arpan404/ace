//! Pure lexical passage search over a fetched page's saved text. No model calls, no I/O.

use super::outline::{Heading, outline};

/// Target maximum length of one returned passage, in characters.
const MAX_PASSAGE_CHARS: usize = 900;
/// Overlap between sub-chunks when splitting a single very long paragraph.
const CHUNK_OVERLAP_CHARS: usize = 120;

const STOP_WORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on",
    "or", "that", "the", "this", "to", "was", "were", "with",
];

/// One passage matching a `web_fetch` query, with its exact 0-based character offsets in the page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Passage {
    /// 0-based character offset of the passage start in the page's readable text.
    pub offset: usize,
    /// 0-based character offset of the passage end (exclusive) in the page's readable text.
    pub end_offset: usize,
    /// Nearest enclosing heading above (or starting) this passage, if any.
    pub section: Option<String>,
    /// The passage text itself.
    pub text: String,
}

#[derive(Debug, Clone)]
struct Chunk {
    offset: usize,
    end_offset: usize,
    section: Option<String>,
    text: String,
    tokens: Vec<String>,
    section_tokens: Vec<String>,
    lower: String,
}

/// Returns up to `max_passages` non-overlapping passages of `text` that best match `query`,
/// keeping total passage text within `max_total_chars`.
#[must_use]
pub fn search_passages(
    text: &str,
    query: &str,
    max_passages: usize,
    max_total_chars: usize,
) -> Vec<Passage> {
    let trimmed_query = query.trim();
    if trimmed_query.is_empty() || text.is_empty() || max_passages == 0 || max_total_chars == 0 {
        return Vec::new();
    }
    let query_terms = query_tokens(trimmed_query);
    if query_terms.is_empty() {
        return Vec::new();
    }
    let chunks = build_chunks(text);
    if chunks.is_empty() {
        return Vec::new();
    }

    let n = chunks.len() as f64;
    let avg_dl = (chunks.iter().map(|c| c.tokens.len()).sum::<usize>() as f64 / n).max(1.0);

    // Document frequency per query term across chunks (body + section heading).
    let mut df = vec![0usize; query_terms.len()];
    for chunk in &chunks {
        for (i, q) in query_terms.iter().enumerate() {
            let in_body = chunk.tokens.iter().any(|t| term_weight(q, t) > 0.0);
            let in_section = chunk.section_tokens.iter().any(|t| term_weight(q, t) > 0.0);
            if in_body || in_section {
                df[i] += 1;
            }
        }
    }
    let idf: Vec<f64> = df
        .iter()
        .map(|&d| {
            let d = d as f64;
            (1.0 + (n - d + 0.5) / (d + 0.5)).ln()
        })
        .collect();
    let idf_sum: f64 = idf.iter().sum();

    let lower_query = trimmed_query.to_lowercase();
    let check_phrase = query_terms.len() >= 2;

    let mut scored: Vec<(usize, f64)> = chunks
        .iter()
        .enumerate()
        .filter_map(|(idx, chunk)| {
            let score = score_chunk(
                chunk,
                &query_terms,
                &idf,
                idf_sum,
                avg_dl,
                check_phrase.then_some(lower_query.as_str()),
            );
            (score > 0.0).then_some((idx, score))
        })
        .collect();

    // Highest score first; tie-break by earlier offset for deterministic output.
    scored.sort_by(|&(a_idx, a_score), &(b_idx, b_score)| {
        b_score
            .total_cmp(&a_score)
            .then_with(|| chunks[a_idx].offset.cmp(&chunks[b_idx].offset))
    });

    let mut chosen: Vec<Passage> = Vec::new();
    let mut used_chars = 0usize;

    for (idx, _) in scored {
        if chosen.len() >= max_passages {
            break;
        }
        let chunk = &chunks[idx];
        let overlaps = chosen
            .iter()
            .any(|p| chunk.offset < p.end_offset && p.offset < chunk.end_offset);
        if overlaps {
            continue;
        }
        let piece_len = chunk.text.chars().count();
        if !chosen.is_empty() && used_chars + piece_len > max_total_chars {
            continue;
        }
        let (piece_text, end_offset) = if piece_len > max_total_chars {
            let cut: String = chunk.text.chars().take(max_total_chars).collect();
            let end = chunk.offset + cut.chars().count();
            (cut, end)
        } else {
            (chunk.text.clone(), chunk.end_offset)
        };
        used_chars += piece_text.chars().count();
        chosen.push(Passage {
            offset: chunk.offset,
            end_offset,
            section: chunk.section.clone(),
            text: piece_text,
        });
    }

    chosen
}

fn score_chunk(
    chunk: &Chunk,
    query_terms: &[String],
    idf: &[f64],
    idf_sum: f64,
    avg_dl: f64,
    phrase: Option<&str>,
) -> f64 {
    const K1: f64 = 1.2;
    const B: f64 = 0.75;

    let dl = chunk.tokens.len().max(1) as f64;
    let norm = 1.0 - B + B * (dl / avg_dl);

    let mut bm25 = 0.0;
    let mut section_score = 0.0;
    let mut distinct_matched = 0usize;

    for (i, q) in query_terms.iter().enumerate() {
        let tf: f64 = chunk.tokens.iter().map(|t| term_weight(q, t)).sum();
        let sec_tf: f64 = chunk.section_tokens.iter().map(|t| term_weight(q, t)).sum();
        if tf > 0.0 || sec_tf > 0.0 {
            distinct_matched += 1;
        }
        if tf > 0.0 {
            bm25 += idf[i] * (tf * (K1 + 1.0)) / (tf + K1 * norm);
        }
        if sec_tf > 0.0 {
            section_score += idf[i] * sec_tf.min(1.0);
        }
    }

    let mut total = bm25 + 0.35 * section_score;
    if total <= 0.0 {
        return 0.0;
    }

    let coverage = distinct_matched as f64 / query_terms.len() as f64;
    total *= 0.5 + 0.5 * coverage;

    if let Some(phrase) = phrase
        && chunk.lower.contains(phrase)
    {
        total += 2.0 * idf_sum;
    }

    total
}

/// Weight for matching query term `q` against document token `t`.
/// Exact matches score 1.0; prefix matches for 4+ character stems score 0.7.
fn term_weight(q: &str, t: &str) -> f64 {
    if q == t {
        1.0
    } else if q.len() >= 4 && t.len() >= 4 && (t.starts_with(q) || q.starts_with(t)) {
        0.7
    } else {
        0.0
    }
}

fn query_tokens(query: &str) -> Vec<String> {
    let raw = tokenize(query);
    let long: Vec<String> = raw
        .iter()
        .filter(|t| t.chars().count() >= 2)
        .cloned()
        .collect();
    let base = if long.is_empty() { raw } else { long };
    let filtered: Vec<String> = base
        .iter()
        .filter(|t| !STOP_WORDS.contains(&t.as_str()))
        .cloned()
        .collect();
    let chosen = if filtered.is_empty() { base } else { filtered };

    let mut unique = Vec::with_capacity(chosen.len());
    for token in chosen {
        if !unique.contains(&token) {
            unique.push(token);
        }
    }
    unique
}

fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// Splits `text` into paragraph-aligned chunks with exact 0-based character offsets and their
/// nearest enclosing heading, walking sorted block and heading offsets once in O(B + H).
fn build_chunks(text: &str) -> Vec<Chunk> {
    let headings = outline(text);
    let blocks = split_blocks(text);
    let merged = merge_heading_blocks(text, blocks, &headings);

    let mut chunks = Vec::new();
    let mut next_heading = 0usize;
    let mut current_section: Option<String> = None;

    for block in merged {
        while next_heading < headings.len() && headings[next_heading].offset <= block.offset {
            let h = &headings[next_heading];
            current_section = Some(format!("{} {}", "#".repeat(usize::from(h.level)), h.text));
            next_heading += 1;
        }

        let block_text = &text[block.start_byte..block.end_byte];
        if block.end_offset - block.offset <= MAX_PASSAGE_CHARS {
            chunks.push(make_chunk(
                block.offset,
                block.end_offset,
                current_section.clone(),
                block_text.to_owned(),
            ));
        } else {
            for (sub_offset, sub_end, sub_text) in split_long_block(block_text, block.offset) {
                chunks.push(make_chunk(
                    sub_offset,
                    sub_end,
                    current_section.clone(),
                    sub_text,
                ));
            }
        }
    }
    chunks
}

fn make_chunk(offset: usize, end_offset: usize, section: Option<String>, text: String) -> Chunk {
    let lower = text.to_lowercase();
    let tokens = tokenize(&text);
    let section_tokens = section.as_deref().map(tokenize).unwrap_or_default();
    Chunk {
        offset,
        end_offset,
        section,
        text,
        tokens,
        section_tokens,
        lower,
    }
}

struct Block {
    offset: usize,
    end_offset: usize,
    start_byte: usize,
    end_byte: usize,
}

/// Splits `text` on blank lines into non-empty blocks with exact character and byte boundaries.
fn split_blocks(text: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut char_pos = 0usize;
    let mut start_char: Option<usize> = None;
    let mut start_byte = 0usize;
    let mut last_non_blank_end_byte = 0usize;
    let mut last_non_blank_end_char = 0usize;
    let mut byte_pos = 0usize;

    for raw_line in text.split_inclusive('\n') {
        let line_chars = raw_line.chars().count();
        let line_bytes = raw_line.len();
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            if let Some(start) = start_char.take() {
                blocks.push(Block {
                    offset: start,
                    end_offset: last_non_blank_end_char,
                    start_byte,
                    end_byte: last_non_blank_end_byte,
                });
            }
        } else {
            if start_char.is_none() {
                start_char = Some(char_pos);
                start_byte = byte_pos;
            }
            let content = raw_line.trim_end_matches(['\r', '\n']);
            last_non_blank_end_byte = byte_pos + content.len();
            last_non_blank_end_char = char_pos + content.chars().count();
        }
        char_pos += line_chars;
        byte_pos += line_bytes;
    }

    if let Some(start) = start_char {
        blocks.push(Block {
            offset: start,
            end_offset: last_non_blank_end_char,
            start_byte,
            end_byte: last_non_blank_end_byte,
        });
    }

    blocks
}

/// Advances cursor `idx` through sorted `headings` to check whether `offset` starts a heading.
fn is_heading_at(headings: &[Heading], idx: &mut usize, offset: usize) -> bool {
    while *idx < headings.len() && headings[*idx].offset < offset {
        *idx += 1;
    }
    *idx < headings.len() && headings[*idx].offset == offset
}

/// Attaches a bare heading block to its immediately following body block when both (including the
/// exact original gap between them) fit inside [`MAX_PASSAGE_CHARS`]. Walks sorted heading offsets
/// once in O(B + H) and preserves exact source boundaries so `text[start_byte..end_byte]` always
/// matches `[offset..end_offset]`.
fn merge_heading_blocks(text: &str, blocks: Vec<Block>, headings: &[Heading]) -> Vec<Block> {
    let mut out: Vec<Block> = Vec::with_capacity(blocks.len());
    let mut iter = blocks.into_iter().peekable();
    let mut h_idx = 0usize;

    while let Some(block) = iter.next() {
        let slice = &text[block.start_byte..block.end_byte];
        let is_heading_only =
            !slice.contains('\n') && is_heading_at(headings, &mut h_idx, block.offset);
        if is_heading_only && let Some(next) = iter.peek() {
            let mut lookahead = h_idx;
            let next_is_heading = is_heading_at(headings, &mut lookahead, next.offset);
            let combined_chars = next.end_offset - block.offset;
            if !next_is_heading
                && combined_chars <= MAX_PASSAGE_CHARS
                && let Some(next) = iter.next()
            {
                out.push(Block {
                    offset: block.offset,
                    end_offset: next.end_offset,
                    start_byte: block.start_byte,
                    end_byte: next.end_byte,
                });
                continue;
            }
        }
        out.push(block);
    }
    out
}

/// Splits a single long block into chunks of at most [`MAX_PASSAGE_CHARS`] characters, preferring
/// line or word boundaries and keeping a small overlap so phrases at split points stay findable.
fn split_long_block(text: &str, base_offset: usize) -> Vec<(usize, usize, String)> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let total = chars.len();
    let mut pieces = Vec::new();
    let mut start = 0usize;

    while start < total {
        let raw_end = (start + MAX_PASSAGE_CHARS).min(total);
        let end = if raw_end < total {
            // Prefer a newline or whitespace break in the last quarter of the window.
            let search_from = start + (MAX_PASSAGE_CHARS * 3 / 4);
            (search_from..raw_end)
                .rev()
                .find(|&i| chars[i].1 == '\n')
                .or_else(|| {
                    (search_from..raw_end)
                        .rev()
                        .find(|&i| chars[i].1.is_whitespace())
                })
                .unwrap_or(raw_end)
        } else {
            raw_end
        };

        let start_byte = chars[start].0;
        let end_byte = if end < total {
            chars[end].0
        } else {
            text.len()
        };
        let slice = text[start_byte..end_byte].trim();
        if !slice.is_empty() {
            // Compute exact char offset of the trimmed slice start.
            let leading = text[start_byte..end_byte]
                .chars()
                .take_while(|c| c.is_whitespace())
                .count();
            let piece_start = base_offset + start + leading;
            let piece_end = piece_start + slice.chars().count();
            pieces.push((piece_start, piece_end, slice.to_owned()));
        }

        if end >= total {
            break;
        }
        let next_start = end.saturating_sub(CHUNK_OVERLAP_CHARS);
        start = if next_start <= start { end } else { next_start };
    }

    pieces
}
