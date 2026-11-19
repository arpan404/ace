// SPDX-License-Identifier: Apache-2.0
use crate::Error;
use media_wire::keys::KeyBlock;
pub const CREDIT_FLAG: u8 = 7;
pub const FLOW_WINDOW: u32 = 1024 * 1024;
pub fn fragment_cost(length: usize) -> usize {
    length.max(4096)
}
pub fn credit_fragment(amount: u32) -> [u8; 5] {
    let mut out = [CREDIT_FLAG, 0, 0, 0, 0];
    out[1..].copy_from_slice(&amount.to_be_bytes());
    out
}
pub fn read_credit(plain: &[u8]) -> Result<u32, Error> {
    if plain.len() != 5 || plain[0] != CREDIT_FLAG {
        return Err(Error::InvalidCredit);
    }
    let amount = u32::from_be_bytes([plain[1], plain[2], plain[3], plain[4]]);
    if amount > FLOW_WINDOW {
        return Err(Error::InvalidCredit);
    }
    Ok(amount)
}
#[derive(Default)]
pub struct FlowCredit {
    limited: bool,
    counting: bool,
    window: u64,
    queued: usize,
    uncounted: usize,
    unacked: usize,
    owed: usize,
}
impl FlowCredit {
    pub(crate) fn import(b: &KeyBlock) -> Result<Self, Error> {
        if b.window > FLOW_WINDOW
            || b.unacked > FLOW_WINDOW
            || b.owed >= FLOW_WINDOW / 4
            || b.owed != b.unacked
            || b.flags == 2
            || b.uncounted != 0
            || (b.flags & 1 == 0 && b.window != 0)
            || (b.flags & 2 == 0 && (b.unacked != 0 || b.owed != 0))
        {
            return Err(Error::InvalidKeyBlock);
        }
        Ok(Self {
            limited: b.flags & 1 != 0,
            counting: b.flags & 2 != 0,
            window: b.window.into(),
            unacked: b.unacked as usize,
            owed: b.owed as usize,
            ..Self::default()
        })
    }
    pub fn limited(&self) -> bool {
        self.limited
    }
    pub fn counting(&self) -> bool {
        self.counting
    }
    pub fn start(&mut self) -> Option<[u8; 5]> {
        if self.limited {
            return None;
        }
        self.limited = true;
        self.window = FLOW_WINDOW.into();
        Some(credit_fragment(0))
    }
    pub fn credited(&mut self, amount: u32) -> Result<Option<[u8; 5]>, Error> {
        if amount > FLOW_WINDOW {
            return Err(Error::InvalidCredit);
        }
        if !self.counting {
            self.counting = true;
            self.uncounted = self.queued;
        }
        let reply = self.start();
        self.window += u64::from(amount);
        Ok(reply)
    }
    pub fn allows(&self, cost: usize) -> bool {
        !self.limited || self.window >= cost as u64
    }
    pub fn spend(&mut self, cost: usize) -> Result<(), Error> {
        if !self.allows(cost) {
            return Err(Error::WindowExceeded);
        }
        if self.limited {
            self.window -= cost as u64;
        }
        Ok(())
    }
    pub fn received(&mut self, cost: usize) -> bool {
        self.queued += 1;
        if !self.counting {
            return true;
        }
        self.unacked = self.unacked.saturating_add(cost);
        self.unacked <= FLOW_WINDOW as usize
    }
    pub fn consumed(&mut self, cost: usize) -> Result<Option<[u8; 5]>, Error> {
        if self.queued == 0 {
            return Err(Error::InvalidCredit);
        }
        self.queued -= 1;
        if self.uncounted > 0 {
            self.uncounted -= 1;
            return Ok(None);
        }
        if !self.counting {
            return Ok(None);
        }
        self.owed = self.owed.checked_add(cost).ok_or(Error::InvalidCredit)?;
        if self.owed < FLOW_WINDOW as usize / 4 {
            return Ok(None);
        }
        if self.owed > self.unacked || self.owed > FLOW_WINDOW as usize {
            return Err(Error::InvalidCredit);
        }
        let credit = credit_fragment(self.owed as u32);
        self.unacked -= self.owed;
        self.owed = 0;
        Ok(Some(credit))
    }
}
