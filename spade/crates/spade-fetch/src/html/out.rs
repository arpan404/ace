//! The readable text being written: whitespace collapsed as it goes, breaks between blocks
//! decided lazily, and a hard cap on its size. Once full, every write is ignored.

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub enum Break {
    #[default]
    None,
    Line,
    Para,
}

/// A point to roll back to, when an element turns out to have written nothing.
#[derive(Clone, Copy)]
pub struct Mark {
    len: usize,
    pending: Break,
    space: bool,
    prefix_at: Option<(usize, Break)>,
}

pub struct Out {
    text: String,
    most: usize,
    full: bool,
    /// The break owed before the next text.
    pending: Break,
    /// A space is owed before the next text.
    space: bool,
    /// While nothing has followed an item or heading prefix yet: where the text stood before
    /// it, and the break that was written for it.
    prefix_at: Option<(usize, Break)>,
    /// No space is written at this length (just after an opening `[` or backtick).
    tight_at: Option<usize>,
    /// Inside a link or inline code: blocks don't break the line.
    pub inline: usize,
    /// Inside link text: `]` is escaped.
    pub in_link: bool,
}

impl Out {
    pub fn new(most: usize) -> Self {
        Self {
            text: String::new(),
            most,
            full: false,
            pending: Break::None,
            space: false,
            prefix_at: None,
            tight_at: None,
            inline: 0,
            in_link: false,
        }
    }

    pub fn full(&self) -> bool {
        self.full
    }

    /// An element opens. Ignored right after a prefix, so `<li><p>x` stays on one line.
    pub fn start(&mut self, at_least: Break) {
        if self.inline > 0 {
            self.space = true;
        } else if self.prefix_at.is_none() {
            self.pending = self.pending.max(at_least);
        }
    }

    /// An element closes. A prefix nothing followed is taken back.
    pub fn end(&mut self, at_least: Break) {
        if self.inline > 0 {
            self.space = true;
            return;
        }
        self.drop_bare_prefix();
        self.pending = self.pending.max(at_least);
    }

    /// A list item closes: the next item follows on the next line.
    pub fn end_item(&mut self) {
        self.drop_bare_prefix();
        self.pending = Break::Line;
    }

    /// A nested list follows its item on the next line, even after a paragraph in the item.
    pub fn tighten(&mut self) {
        self.pending = self.pending.min(Break::Line);
    }

    fn drop_bare_prefix(&mut self) {
        if let Some((at, owed)) = self.prefix_at.take() {
            self.text.truncate(at);
            self.pending = self.pending.max(owed);
        }
    }

    pub fn prefix(&mut self, prefix: &str) {
        self.drop_bare_prefix();
        let at = self.text.len();
        let owed = self.pending;
        self.flush_break();
        self.push(prefix);
        self.prefix_at = Some((at, owed));
        self.space = false;
    }

    /// Text written as is, after any owed break: a code block.
    pub fn raw(&mut self, raw: &str) {
        self.flush_break();
        if self.space {
            self.push(" ");
        }
        self.push(raw);
        self.prefix_at = None;
        self.space = false;
    }

    /// Opens a link or code span with `opener`; nothing is spaced right after it. Returns the
    /// length just after the opener, so a caller can tell whether anything followed.
    pub fn open(&mut self, opener: &str) -> usize {
        self.word(opener);
        self.tight_at = Some(self.text.len());
        self.text.len()
    }

    /// Closes a link or code span with `closer`, keeping any owed space for after it.
    pub fn close(&mut self, closer: &str) {
        self.push(closer);
        self.tight_at = None;
    }

    pub fn mark(&self) -> Mark {
        Mark {
            len: self.text.len(),
            pending: self.pending,
            space: self.space,
            prefix_at: self.prefix_at,
        }
    }

    /// The length of the text so far.
    pub fn len(&self) -> usize {
        self.text.len()
    }

    pub fn back_to(&mut self, mark: Mark) {
        self.text.truncate(mark.len);
        self.pending = mark.pending;
        self.space = mark.space;
        self.prefix_at = mark.prefix_at;
        self.tight_at = None;
    }

    pub fn text(&mut self, text: &str) {
        for word in text.split_inclusive(char::is_whitespace) {
            let trimmed = word.trim_end_matches(char::is_whitespace);
            if !trimmed.is_empty() {
                if self.in_link && trimmed.contains(']') {
                    self.word(&trimmed.replace(']', "\\]"));
                } else {
                    self.word(trimmed);
                }
            }
            if trimmed.len() < word.len() {
                self.space = true;
            }
            if self.full {
                return;
            }
        }
    }

    fn word(&mut self, word: &str) {
        if self.pending != Break::None {
            self.flush_break();
        } else if self.space
            && !self.text.is_empty()
            && self.tight_at != Some(self.text.len())
            && !self.text.ends_with([' ', '\n'])
        {
            self.push(" ");
        }
        self.push(word);
        self.prefix_at = None;
        self.space = false;
    }

    fn flush_break(&mut self) {
        let owed = std::mem::take(&mut self.pending);
        if owed == Break::None {
            return;
        }
        self.space = false;
        let kept = self.text.trim_end_matches(' ').len();
        self.text.truncate(kept);
        if self.text.is_empty() {
            return;
        }
        self.push(if owed == Break::Para { "\n\n" } else { "\n" });
    }

    fn push(&mut self, s: &str) {
        if self.full {
            return;
        }
        let room = self.most.saturating_sub(self.text.len());
        if s.len() <= room {
            self.text.push_str(s);
            return;
        }
        let mut end = room;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        self.text.push_str(&s[..end]);
        self.full = true;
    }

    pub fn finish(mut self) -> String {
        if !self.full {
            self.drop_bare_prefix();
        }
        self.text.trim().to_owned()
    }
}
