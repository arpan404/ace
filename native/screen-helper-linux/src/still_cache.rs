//! The last still published, kept to send again when someone starts watching a still screen
//! and the capture holds no buffer to make a new one from. A still shows one visible region of
//! its buffer (the window inside a larger buffer): once a buffer showing another region has
//! arrived, the cached one is stale and is never sent again.

/// A visible region: left, top, width, height.
pub type Region = (u32, u32, u32, u32);

#[derive(Debug)]
pub struct StillCache<T> {
    cached: Option<(Region, T)>,
}

impl<T> Default for StillCache<T> {
    fn default() -> Self {
        Self { cached: None }
    }
}

impl<T> StillCache<T> {
    /// `still` was published, made of a buffer showing `region`.
    pub fn store(&mut self, region: Region, still: T) {
        self.cached = Some((region, still));
    }

    /// A buffer showing `region` arrived, whether or not anything was published from it.
    pub fn seen(&mut self, region: Region) {
        if self
            .cached
            .as_ref()
            .is_some_and(|(cached, _)| *cached != region)
        {
            self.cached = None;
        }
    }

    /// The still to send again, if it still shows what the screen shows.
    pub fn replay(&self) -> Option<&T> {
        self.cached.as_ref().map(|(_, still)| still)
    }
}

#[cfg(test)]
mod tests {
    use super::StillCache;

    const A: (u32, u32, u32, u32) = (0, 0, 410, 666);
    const B: (u32, u32, u32, u32) = (120, 40, 410, 666);

    #[test]
    fn a_still_of_a_region_the_screen_no_longer_shows_is_never_sent_again() {
        let mut cache = StillCache::default();
        // Watched: a still of region A is published and cached.
        cache.store(A, "still of A");
        // Unwatched: a buffer showing region B arrives (the window moved); nothing is
        // published from it. Then PipeWire takes the held buffer back, and someone watches
        // again: with no buffer to make a still from, the cache is all there is.
        cache.seen(B);
        assert_eq!(
            cache.replay(),
            None,
            "A is never emitted for a screen showing B"
        );
    }

    #[test]
    fn a_still_of_the_region_still_shown_is_sent_again() {
        let mut cache = StillCache::default();
        cache.store(A, "still of A");
        cache.seen(A);
        assert_eq!(cache.replay(), Some(&"still of A"));
    }
}
