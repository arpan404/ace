# 0149: Media holds up on 3G

Status: accepted. Date: 2026-11-14. Decided by: the owner (networking audit, 2026-11-14: every
connection feels instant on 3G, and live video to phones and mobile web is held to the same
idea). Amends [ADR 0147](0147-ace-media-rust-media-pipeline.md) (pacing, start-up and the
relay) and [ADR 0148](0148-ace-media-gpu-accelerated.md) (encoders). The build plan is the
"3G" section of [docs/media/plan.md](../media/plan.md).

## Context

The target link is 3G as phones see it:

- 400 kbit/s to 1.6 Mbit/s down;
- 300–500 ms round trip;
- 1–2 % loss;
- the phone reaching the Mac only through the relay, with TCP on both legs.

Today's pipeline assumes far better:

- **Bit rate floors.** The minimum bit rate is 500 kbit/s (`link_rate.rs`, `plan.rs`,
  `video-policy.ts`). Screens and devices never go below 1 Mbit/s, and the relay device profile
  asks for 1080 × 2160 at 5 Mbit/s (`screen_profile.rs`).
- **Frame rate.** It is fixed at 60 fps.
- **First picture.** It starts at 1.5 Mbit/s, sized to the viewport times its pixel ratio.
- **The estimator** reads only round-trip time, so on a lossy TCP link a retransmit stall looks
  like congestion.
- **The backlog** is bounded in frames and bytes, not in time.
- **Video and the main session.** Nothing caps video's share of the link against the main
  session, and clients give no hint about their link.
- **The benches** run at 25 Mbit/s and 120 ms, with no loss.

## Decision

1. **A 3G bench profile (N1).** `video-link.ts` and the native media bench gain:
   - **Links:** 400k, 800k and 1.6M down, at 300–500 ms round trip.
   - **Loss:** 1–2 %, modelled as TCP retransmit stalls on both legs.
   - **Slow start, and a competing flow.**
   - **Reports:** time to first picture, glass-to-glass delay and tap-to-picture.

   These targets replace C2's "60 fps on the phone-link profile".

2. **Pacing follows the link down to a floor of about 150 kbit/s (M2b).** It changes in the
   TypeScript live path and in `media-core` together, so today's path improves at once and the
   shared vectors stay in parity.
   - **Frame rate steps before the picture shrinks** (60, 30, 15, 8, 5 fps) for screens and
     browser tabs, so text stays sharp.
   - **Screen and device profiles follow the link,** with no 1 Mbit/s floor.
   - **The backlog is bounded in time:** bytes in flight ≤ link capacity × (RTT + 300 ms).
   - **The estimator tolerates loss.**
     - It measures a chunk's delay net of the chunk's own send time.
     - It cuts only when queueing persists.
     - It reads a timeout-sized spike as loss, not as congestion.
   - **Start low when told.** A viewer starts at a low step when its link hint says so.
3. **Keyframes are capped at about rate × 0.5 s** on every encoder: B1–B5, and today's
   TypeScript-driven encoders. The cap is coupled with picture scale, so a keyframe at the floor
   is a smaller sharp picture, not a large mushy one.
4. **Clients say what link they are on (K3).**
   - **The hint.** `viewer.open` carries a link hint: `NWPath` `isExpensive`/`isConstrained`
     on iOS; `navigator.connection` `effectiveType`, `downlink` and `rtt` on the web; and
     `Save-Data`. It goes in `packages/protocol` for today's path and in `media-wire`.
     - It only picks the starting step, and never raises the rate above what the link has
       measured. It is the client's word, so it is bounded and parsed as untrusted.
   - **Pause and resume.** Hidden or backgrounded clients pause and resume explicitly, instead
     of only owing acks.
   - **The main session's state.** The daemon tells ace-media the main session's round trip and
     backlog.
5. **The media connection opens with the main session (D1, D2, C1, C2).** Subscribes travel
   with the hello. This is coordinated with the main-session handshake work already in progress
   (subscribes in the hello, tickets in the welcome).
6. **A poster comes first (F2 with D1).** The subscribe reply carries a viewport-sized still of
   10–20 KB, so a picture shows within about a second, before video starts.
7. **Video shares the relay (D1, D2).** Video takes at most about 70 % of the link estimate, and
   less as soon as the main session's round trip inflates. The conversation stays responsive
   while video plays.
8. **The handshake change is the daemon's.** The planned one-round-trip relay handshake (Noise
   IK, with the hello in the first message) changes the daemon's handshake, not `media-noise`:
   ace-media never handshakes. `media-noise` only needs the key block (ADR 0147 §5) to stay as
   it is.

## Consequences

**Expected results** after this. These are estimates, to be confirmed by N1.

| Link       | Picture                                                                               | Lag       | Start                                       |
| ---------- | ------------------------------------------------------------------------------------- | --------- | ------------------------------------------- |
| 400 kbit/s | 640–720 px wide at 5–10 fps while scrolling; a sharp frame 0.5–1 s after motion stops | 0.8–1.5 s | poster within about 1 s, video by about 2 s |
| 1.6 Mbit/s | about 720p at 15 fps                                                                  | 0.6–1 s   | —                                           |

**Out of reach on TCP through a Worker.** Neither leg of the relay can do these, and this ADR
doesn't promise them:

- tolerating loss in less than one round trip per lost packet;
- a picture faster than one round trip plus one frame;
- sharp 30–60 fps at 400 kbit/s;
- any lossy datagram lane.

**Cost.** Pacing moves in both languages at once, so each change ships with regenerated shared
vectors and both implementations replaying them.
