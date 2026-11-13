//! Keeping ace's side of each bot's computer in step with Spade's (ADR 0142). Spade's record of
//! who drives is the truth and survives restarts; the daemon keeps its copy in memory. So Spade
//! tells the daemon on take-over and hand-back, and then every few seconds tells it again for every
//! bot the person has (a daemon that restarted learns it back) and every hand-back it hasn't
//! confirmed. At start it reads each bot's browser and screen from ace, since reports sent while
//! Spade was down are lost.

use std::sync::Arc;
use std::time::Duration;

use super::daemon::{AceComputer, Daemon, Handback};
use super::{Computers, Driver, Kind, lock};

/// How often the daemon is told again.
pub const RESYNC: Duration = Duration::from_secs(10);
/// How long a take-over or hand-back waits for the daemon before carrying on without it. ace
/// answers a take-over once the bot's calls in flight have ended, which can take 10 s.
const ASK: Duration = Duration::from_secs(20);

impl Computers {
    /// Gives the computers ace's daemon, and starts keeping it in step: every `agents` bot's
    /// browser and screen are read from it, then each `every`.
    pub fn set_daemon(
        self: &Arc<Self>,
        daemon: Arc<dyn Daemon>,
        agents: Vec<String>,
        every: Duration,
    ) {
        if self.daemon.set(daemon).is_err() {
            return;
        }
        lock(&self.unread).extend(agents);
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(computers) = me.upgrade() else {
                    return;
                };
                computers.resync().await;
                drop(computers);
                tokio::time::sleep(every).await;
            }
        });
    }

    fn daemon(&self) -> Option<Arc<dyn Daemon>> {
        self.daemon.get().cloned()
    }

    /// One round: ace hears again who drives, and bots not yet read are read.
    pub async fn resync(&self) {
        let Some(daemon) = self.daemon() else {
            return;
        };
        for bot in self.held() {
            let answer = tokio::time::timeout(ASK, daemon.drive(&bot, Driver::Person)).await;
            if let Ok(Ok(answer)) = answer {
                self.ace_stopped(&bot, answer.stopped);
            }
        }
        let releasing: Vec<String> = lock(&self.releasing).iter().cloned().collect();
        for bot in releasing {
            if let Ok(Ok(_)) = tokio::time::timeout(ASK, daemon.drive(&bot, Driver::Bot)).await {
                lock(&self.releasing).remove(&bot);
            }
        }
        let unread: Vec<String> = lock(&self.unread).iter().cloned().collect();
        for bot in unread {
            if let Ok(Ok(computer)) = tokio::time::timeout(ASK, daemon.computer(&bot)).await {
                lock(&self.unread).remove(&bot);
                self.apply_ace(&bot, &computer);
            }
        }
    }

    /// Tells ace the person drives `agent`'s browser and screen. Not reaching it is fine: the
    /// next round tells it again.
    pub async fn ace_takes_over(&self, agent: &str) {
        lock(&self.releasing).remove(agent);
        if let Some(daemon) = self.daemon() {
            let answer = tokio::time::timeout(ASK, daemon.drive(agent, Driver::Person)).await;
            if let Ok(Ok(answer)) = answer {
                self.ace_stopped(agent, answer.stopped);
            }
        }
    }

    /// ace said whether the bot's work there has stopped since the person took over.
    fn ace_stopped(&self, agent: &str, stopped: bool) {
        if !stopped || self.driver(agent) != Driver::Person {
            return;
        }
        if lock(&self.stopping).remove(agent) {
            self.changed(agent);
        }
    }

    /// Hands `agent`'s browser and screen back to the bot in ace; answers what the person did
    /// there. When ace can't be reached, later rounds hand back again and the note goes without.
    pub async fn ace_hands_back(&self, agent: &str) -> Option<Handback> {
        let daemon = self.daemon()?;
        match tokio::time::timeout(ASK, daemon.drive(agent, Driver::Bot)).await {
            Ok(Ok(answer)) => {
                lock(&self.releasing).remove(agent);
                answer.handback
            }
            _ => {
                lock(&self.releasing).insert(agent.to_owned());
                None
            }
        }
    }

    /// The bot's browser and screen as ace keeps them.
    fn apply_ace(&self, agent: &str, computer: &AceComputer) {
        let now = self.clock.now_ms();
        if let Some(thread) = &computer.thread_id {
            lock(&self.threads).insert(agent.to_owned(), thread.clone());
        }
        // ace still has the person driving a bot Spade gave back (a hand-back it never heard).
        if computer.driver == Driver::Person && self.driver(agent) == Driver::Bot {
            lock(&self.releasing).insert(agent.to_owned());
        }
        {
            let mut all = lock(&self.surfaces);
            let tab = computer.browser.tabs.last();
            if let Some(tab) = tab {
                let browser = all.entry((agent.to_owned(), Kind::Browser)).or_default();
                browser.title = Some(tab.title.chars().take(200).collect());
                browser.url = Some(tab.url.chars().take(2000).collect());
                browser.tab_id = Some(tab.tab_id.clone());
                browser.backend = tab.backend.clone();
                browser.last = browser.last.or(Some(now));
            }
            if !computer.screen.apps.is_empty() {
                let screen = all.entry((agent.to_owned(), Kind::Screen)).or_default();
                screen.reported_live = true;
                screen.title = Some(computer.screen.apps.join(", ").chars().take(200).collect());
                screen.since = computer.screen.since.or(Some(now));
                screen.last = Some(now);
            }
        }
        self.changed(agent);
    }
}
