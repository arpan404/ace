// SPDX-License-Identifier: Apache-2.0
use crate::{Error, Fragment, FragmentKind};
use zeroize::Zeroizing;
/// Joins ordered plaintext fragments. JSON inflation and authorization belong to the caller.
#[derive(Default)]
pub struct MessageAssembler {
    kind: Option<FragmentKind>,
    data: Zeroizing<Vec<u8>>,
}
pub struct Message {
    pub kind: FragmentKind,
    pub data: Zeroizing<Vec<u8>>,
}
impl MessageAssembler {
    pub fn push(&mut self, plain: &[u8]) -> Result<Option<Message>, Error> {
        match self.append(plain) {
            Ok(result) => Ok(result),
            Err(error) => {
                self.kind = None;
                self.data = Zeroizing::new(Vec::new());
                Err(error)
            }
        }
    }
    fn append(&mut self, plain: &[u8]) -> Result<Option<Message>, Error> {
        let fragment = Fragment::decode(plain)?;
        if self.kind.is_some_and(|kind| kind != fragment.kind) {
            return Err(Error::InvalidFragment);
        }
        let limit = if fragment.kind == FragmentKind::Binary {
            64 * 1024 + 16
        } else {
            16 * 1024 * 1024
        };
        if self.data.len() + fragment.data.len() > limit {
            return Err(Error::TooLarge);
        }
        self.kind = Some(fragment.kind);
        self.data.extend_from_slice(fragment.data);
        if !fragment.last {
            return Ok(None);
        }
        self.kind = None;
        Ok(Some(Message {
            kind: fragment.kind,
            data: std::mem::replace(&mut self.data, Zeroizing::new(Vec::new())),
        }))
    }
}
