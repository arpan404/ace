// SPDX-License-Identifier: Apache-2.0
//! The host's callbacks into one channel: admission, frames, timers and the
//! exit that ends the tenant.

use super::*;

impl ChannelHandlers for SessionChannel {
    fn admit(&self, dir: Direction, data: &Value) -> Admission {
        let dir = match dir {
            Direction::Send => FrameDir::Send,
            Direction::Recv => FrameDir::Recv,
        };
        match crate::session::frames::admission(self.bearer.as_deref(), dir, data) {
            Some(message) => Admission::Failed(message),
            None => Admission::Taken,
        }
    }

    fn frame(&self, dir: Direction, data: &Value) {
        self.frame(dir, data);
    }

    fn notification(&self, method: &JsString, params: Option<&Value>) {
        let effects = {
            let mut core = self.core();
            core.session.notification(method.as_str(), params)
        };
        self.apply(effects);
    }

    fn request(&self, id: &RpcId, method: &JsString, params: Option<&Value>) -> RequestAnswer {
        self.core().session.request(id, method.as_str(), params)
    }

    fn dropped(&self, line: &DroppedLine) {
        let effects = {
            let mut core = self.core();
            core.session.dropped(line)
        };
        self.apply(effects);
    }

    fn output_uncertain(&self) {
        let effects = {
            let mut core = self.core();
            core.session.output_uncertain()
        };
        self.apply(effects);
    }

    fn malformed(&self, line: &str) {
        let effects = {
            let mut core = self.core();
            core.session.malformed(line)
        };
        self.apply(effects);
    }

    fn stderr(&self, line: &str) {
        let effects = {
            let mut core = self.core();
            core.session.stderr(line)
        };
        self.apply(effects);
    }

    fn error(&self, message: &str) {
        let effects = {
            let mut core = self.core();
            core.session.diagnostic(message)
        };
        self.apply(effects);
    }

    fn failed(&self, message: &str) {
        let effects = {
            let mut core = self.core();
            core.session.failed(message)
        };
        self.apply(effects);
    }

    fn exited(&self, exit: &HostExit) {
        self.host_exited(exit);
    }

    fn ready(&self) {
        self.open_ready();
    }
}
