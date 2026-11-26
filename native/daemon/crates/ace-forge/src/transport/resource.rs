// SPDX-License-Identifier: Apache-2.0
//! Resource reads (`resource.ts`): a page's decoded body is cached by the page's own
//! identity, and a projection is reused while the same page and the same entry are seen.
//! One connection is retained, never a map of histories; the delta a caller publishes is
//! [`CollectionVersions::changes`]'s.

use std::collections::HashMap;

use ace_json::Value;

use crate::schema::github::Kind;
use crate::transport::command::Cancellation;
use crate::transport::error::ForgeError;
use crate::transport::http::{GhApi, Page};
use crate::transport::limits::ReadBudget;

/// The most items one resource read keeps.
pub const MAX_RESOURCE_ITEMS: usize = 2_000;

/// One decoded page body, cached by the page's identity.
pub struct PageDecoder<T> {
    decoded: HashMap<u64, T>,
}

impl<T: Clone> Default for PageDecoder<T> {
    fn default() -> Self {
        PageDecoder {
            decoded: HashMap::new(),
        }
    }
}

impl<T: Clone> PageDecoder<T> {
    /// A fresh decoder.
    pub fn new() -> PageDecoder<T> {
        PageDecoder::default()
    }

    /// The page's decoded body, decoding it once.
    pub fn read(
        &mut self,
        page: &Page,
        decode: impl Fn(&Value) -> Result<T, Kind>,
    ) -> Result<T, ForgeError> {
        if let Some(known) = self.decoded.get(&page.id) {
            return Ok(known.clone());
        }
        let decoded = decode(&page.body).map_err(|_| ForgeError::new(Kind::InvalidData))?;
        self.decoded.insert(page.id, decoded.clone());
        Ok(decoded)
    }
}

/// The connection a read holds: the projected items and each page's raw body.
#[derive(Debug, Clone, PartialEq)]
pub struct Resource<T> {
    pub items: Vec<T>,
    pub raw: Vec<Value>,
}

/// One current connection, reusing every unchanged page's projection.
#[allow(clippy::type_complexity)]
pub struct ResourceReader<T, U> {
    decode: Box<dyn Fn(&Value) -> Result<Vec<T>, Kind> + Send + Sync>,
    id_of: Box<dyn Fn(&T) -> i64 + Send + Sync>,
    project: Box<dyn Fn(&T) -> U + Send + Sync>,
    same: Box<dyn Fn(&T, &T) -> bool + Send + Sync>,
    decoder: PageDecoder<Vec<T>>,
    /// The projection of each page, by page identity.
    projected: HashMap<u64, Vec<U>>,
    /// The source each item was projected from, by the entry's id.
    records: HashMap<i64, (T, U)>,
    pages: Vec<Page>,
    last: Option<Resource<U>>,
}

impl<T: Clone + PartialEq, U: Clone + PartialEq> ResourceReader<T, U> {
    /// A reader over one page schema and its projection.
    #[allow(clippy::type_complexity)]
    pub fn new(
        decode: Box<dyn Fn(&Value) -> Result<Vec<T>, Kind> + Send + Sync>,
        id_of: Box<dyn Fn(&T) -> i64 + Send + Sync>,
        project: Box<dyn Fn(&T) -> U + Send + Sync>,
        same: Box<dyn Fn(&T, &T) -> bool + Send + Sync>,
    ) -> ResourceReader<T, U> {
        ResourceReader {
            decode,
            id_of,
            project,
            same,
            decoder: PageDecoder::new(),
            projected: HashMap::new(),
            records: HashMap::new(),
            pages: Vec::new(),
            last: None,
        }
    }

    /// Reads every page of `path` and projects them.
    pub async fn read(
        &mut self,
        api: &GhApi<'_>,
        path: &str,
        cancellation: Option<std::sync::Arc<Cancellation>>,
        budget: &mut ReadBudget,
    ) -> Result<Resource<U>, ForgeError> {
        let pages = api.pages(path, cancellation, budget).await?;
        self.project(pages)
    }

    /// The connection `pages` hold, or the retained one when it is the same connection.
    pub fn project(&mut self, pages: Vec<Page>) -> Result<Resource<U>, ForgeError> {
        if let Some(last) = &self.last
            && pages.len() == self.pages.len()
            && pages
                .iter()
                .zip(self.pages.iter())
                .all(|(now, before)| now.id == before.id)
        {
            return Ok(last.clone());
        }
        let mut projected = Vec::with_capacity(pages.len());
        for page in &pages {
            if let Some(known) = self.projected.get(&page.id) {
                projected.push(known.clone());
                continue;
            }
            let decode = &self.decode;
            let source = self.decoder.read(page, |body| decode(body))?;
            let mut items = Vec::with_capacity(source.len());
            for entry in &source {
                let id = (self.id_of)(entry);
                let item = match self.records.get(&id) {
                    Some((previous, item)) if (self.same)(previous, entry) => item.clone(),
                    _ => (self.project)(entry),
                };
                items.push(item);
            }
            self.projected.insert(page.id, items.clone());
            projected.push(items);
        }
        let items: Vec<U> = projected.into_iter().flatten().collect();
        if items.len() > MAX_RESOURCE_ITEMS {
            return Err(ForgeError::new(Kind::Limit));
        }
        // Keep the source of every current item, so the next read reuses unchanged entries.
        self.records.clear();
        for page in &pages {
            let decode = &self.decode;
            let source = self.decoder.read(page, |body| decode(body))?;
            let items = self.projected.get(&page.id).cloned().unwrap_or_default();
            for (entry, item) in source.iter().zip(items) {
                self.records
                    .insert((self.id_of)(entry), (entry.clone(), item));
            }
        }
        let raw: Vec<Value> = pages.iter().map(|page| page.body.clone()).collect();
        self.pages = pages;
        let resource = Resource { items, raw };
        self.last = Some(resource.clone());
        Ok(resource)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use ace_json::{Value, json};

    use super::{PageDecoder, ResourceReader};
    use crate::schema::github::Kind;
    use crate::transport::http::Page;

    fn page(id: u64, body: Value) -> Page {
        Page {
            id,
            body,
            headers: Vec::new(),
            bytes: 1,
            version: String::from("v"),
            identity_changed: false,
        }
    }

    #[test]
    fn a_page_is_decoded_once_by_its_identity() {
        let mut decoder = PageDecoder::new();
        let first = page(1, json!([1, 2]));
        let parsed = decoder
            .read(&first, |body| {
                Ok(body.as_array().map(|items| items.len()).unwrap_or(0))
            })
            .expect("decodes");
        assert_eq!(parsed, 2);
        // A different body with the same identity is the cached answer, as the WeakMap is.
        let same = decoder
            .read(&page(1, json!([])), |_| Err(Kind::InvalidData))
            .expect("cached");
        assert_eq!(same, 2);
    }

    #[test]
    fn a_projection_is_reused_until_its_page_changes() {
        let mut reader: ResourceReader<i64, i64> = ResourceReader::new(
            Box::new(|body| {
                Ok(body
                    .as_array()
                    .map(|items| items.iter().filter_map(|item| item.as_i64()).collect())
                    .unwrap_or_default())
            }),
            Box::new(|value| *value),
            Box::new(|value| value * 10),
            Box::new(|a, b| a == b),
        );
        let first = reader
            .project(vec![page(1, json!([1, 2]))])
            .expect("projects");
        assert_eq!(first.items, vec![10, 20]);
        let again = reader
            .project(vec![page(1, json!([1, 2]))])
            .expect("projects");
        assert_eq!(again, first);
        // A changed body arrives on a new page (a new identity), where the cache must not
        // answer with the old body.
        let changed = reader
            .project(vec![page(2, json!([1, 3]))])
            .expect("projects");
        assert_eq!(changed.items, vec![10, 30]);
        assert_eq!(changed.raw, vec![json!([1, 3])]);
    }

    #[test]
    fn more_than_the_bound_is_a_limit() {
        let mut reader: ResourceReader<i64, i64> = ResourceReader::new(
            Box::new(|_| Ok(vec![1; 2_001])),
            Box::new(|value| *value),
            Box::new(|value| *value),
            Box::new(|a, b| a == b),
        );
        let error = reader
            .project(vec![page(1, json!([]))])
            .expect_err("over the bound");
        assert_eq!(error.kind, Kind::Limit);
    }
}
