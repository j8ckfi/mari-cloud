//! Content-free attention detection on the raw PTY output stream (spec 6.1-6.3).
//!
//! The detector never reads, interprets, or answers agent content. It observes
//! only three generic terminal signals and reports which one fired — nothing
//! else. The two byte-level signals are handled here by a minimal VT state
//! machine:
//!
//! - **Bell**: a `BEL` (0x07) in ground state — i.e. NOT the `BEL` that
//!   terminates an OSC string. Consecutive bells with no intervening output
//!   collapse to one event (one bell "episode"); ordinary output re-arms it.
//! - **Osc**: a completed `OSC 9` or `OSC 777` notification sequence
//!   (`ESC ] 9 ; … BEL/ST` or `ESC ] 777 ; … BEL/ST`). Only the command number
//!   matters; the payload text is never inspected or retained.
//!
//! The third signal — silence (a blocked read with no output past the idle
//! threshold) — is a timing property of the stream, handled by the run's
//! housekeeping loop rather than this byte machine; see [`crate::run`].
//!
//! The output of [`AttentionDetector::feed`] is a list of
//! [`AttentionKind`] values only. No terminal text ever leaves this module.

use mari_proto::AttentionKind;

const BEL: u8 = 0x07;
const ESC: u8 = 0x1b;

/// Where the VT parser is within the byte stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    /// Normal text.
    Ground,
    /// Saw `ESC`; the next byte selects a sequence type.
    Escape,
    /// Inside a CSI sequence (`ESC [ …`), consuming until a final byte.
    Csi,
    /// Inside an OSC string (`ESC ] …`), consuming until `BEL` or `ST`.
    Osc,
    /// Inside an OSC string and just saw `ESC`; a following `\` is the `ST`
    /// terminator, anything else keeps us in the string.
    OscEsc,
}

/// A minimal, content-free VT scanner that emits attention kinds.
#[derive(Debug)]
pub struct AttentionDetector {
    state: State,
    /// The digits of the current OSC command number, collected until the first
    /// `;`. Never contains payload text.
    osc_num: Vec<u8>,
    /// Whether the current OSC's command number is a notification target (9 or
    /// 777). `None` until the first `;` fixes it.
    osc_is_target: Option<bool>,
    /// True immediately after a bell was emitted; suppresses a run of bells and
    /// is cleared by the next ordinary byte so a later bell counts again.
    bell_armed: bool,
}

impl Default for AttentionDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl AttentionDetector {
    /// A fresh detector in ground state.
    pub fn new() -> Self {
        Self {
            state: State::Ground,
            osc_num: Vec::new(),
            osc_is_target: None,
            bell_armed: false,
        }
    }

    /// Feed a slice of raw PTY output; return the attention kinds detected,
    /// in order. Bytes are consumed statefully, so a sequence split across two
    /// `feed` calls is still detected.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<AttentionKind> {
        let mut out = Vec::new();
        for &b in bytes {
            self.step(b, &mut out);
        }
        out
    }

    fn step(&mut self, b: u8, out: &mut Vec<AttentionKind>) {
        match self.state {
            State::Ground => match b {
                ESC => self.state = State::Escape,
                BEL => {
                    if !self.bell_armed {
                        out.push(AttentionKind::Bell);
                        self.bell_armed = true;
                    }
                    // A run of bells stays one episode; do not clear bell_armed.
                }
                _ => self.bell_armed = false,
            },
            State::Escape => {
                self.bell_armed = false;
                match b {
                    b'[' => self.state = State::Csi,
                    b']' => {
                        self.state = State::Osc;
                        self.osc_num.clear();
                        self.osc_is_target = None;
                    }
                    // Other string-introducers (DCS/APC/PM/SOS) and simple
                    // escapes: return to ground. v0 does not model DCS payloads.
                    _ => self.state = State::Ground,
                }
            }
            State::Csi => {
                // Parameters/intermediates 0x20..=0x3f; final byte 0x40..=0x7e.
                if (0x40..=0x7e).contains(&b) {
                    self.state = State::Ground;
                }
                // A BEL here is inside a sequence, so it is not a bell.
            }
            State::Osc => match b {
                BEL => {
                    self.finish_osc(out);
                }
                ESC => self.state = State::OscEsc,
                b';' => {
                    if self.osc_is_target.is_none() {
                        self.osc_is_target = Some(self.osc_num_is_target());
                    }
                    // Remain in Osc; payload after ';' is never inspected.
                }
                _ => {
                    if self.osc_is_target.is_none() {
                        // Still reading the command number.
                        self.osc_num.push(b);
                    }
                    // else: payload byte, ignored.
                }
            },
            State::OscEsc => {
                if b == b'\\' {
                    // ST terminates the OSC string.
                    self.finish_osc(out);
                } else {
                    // Not an ST; stay inside the OSC string. If the byte is
                    // another ESC, re-enter OscEsc, else back to Osc.
                    self.state = if b == ESC { State::OscEsc } else { State::Osc };
                }
            }
        }
    }

    /// True when the collected OSC command number is a notification target
    /// (`9` or `777`).
    fn osc_num_is_target(&self) -> bool {
        self.osc_num == b"9" || self.osc_num == b"777"
    }

    /// Terminate the current OSC string, emitting an `Osc` event if the command
    /// number was a notification target. The terminating `BEL`/`ST` is part of
    /// the sequence, so it never counts as a bell, and it re-arms the bell.
    fn finish_osc(&mut self, out: &mut Vec<AttentionKind>) {
        // If the number was never separated by ';', decide now (e.g. bare
        // `ESC ] 9 BEL`, which some emitters use).
        let target = match self.osc_is_target {
            Some(t) => t,
            None => self.osc_num_is_target(),
        };
        if target {
            out.push(AttentionKind::Osc);
        }
        self.state = State::Ground;
        self.osc_num.clear();
        self.osc_is_target = None;
        self.bell_armed = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_bell_is_one_bell_event() {
        let mut d = AttentionDetector::new();
        assert_eq!(d.feed(b"\x07"), vec![AttentionKind::Bell]);
    }

    #[test]
    fn bell_amid_text_counts_but_run_of_bells_is_one_episode() {
        let mut d = AttentionDetector::new();
        // "abc" then BEL -> one bell; more bells with no output -> still one.
        let ev = d.feed(b"abc\x07\x07\x07");
        assert_eq!(ev, vec![AttentionKind::Bell]);
        // Output re-arms; a later bell is a new episode.
        let ev2 = d.feed(b"x\x07");
        assert_eq!(ev2, vec![AttentionKind::Bell]);
    }

    #[test]
    fn osc9_bel_terminated_is_one_osc_and_no_bell() {
        let mut d = AttentionDetector::new();
        let ev = d.feed(b"\x1b]9;build finished\x07");
        assert_eq!(ev, vec![AttentionKind::Osc]);
    }

    #[test]
    fn osc777_st_terminated_is_one_osc() {
        let mut d = AttentionDetector::new();
        // ESC ] 777 ; notify ; title ; body ST(ESC \)
        let ev = d.feed(b"\x1b]777;notify;Title;Body\x1b\\");
        assert_eq!(ev, vec![AttentionKind::Osc]);
    }

    #[test]
    fn non_notification_osc_is_ignored() {
        let mut d = AttentionDetector::new();
        // OSC 0 sets the window title; not a notification, must NOT emit.
        let ev = d.feed(b"\x1b]0;my window title\x07");
        assert!(ev.is_empty(), "OSC 0 must not raise attention: {ev:?}");
    }

    #[test]
    fn plain_text_raises_nothing() {
        let mut d = AttentionDetector::new();
        let ev = d.feed(b"hello world, this is normal output\r\n$ ");
        assert!(ev.is_empty(), "plain output must be silent: {ev:?}");
    }

    #[test]
    fn sequence_split_across_feeds_is_detected() {
        let mut d = AttentionDetector::new();
        assert!(d.feed(b"\x1b]7").is_empty());
        assert!(d.feed(b"77;bo").is_empty());
        let ev = d.feed(b"dy\x07");
        assert_eq!(ev, vec![AttentionKind::Osc]);
    }

    #[test]
    fn csi_containing_bel_value_is_not_a_bell() {
        // A CSI sequence never terminates on BEL; ensure a stray 0x07 while a
        // CSI is open is treated as part of the (malformed) sequence, not a
        // bell. Then a real ground bell still fires.
        let mut d = AttentionDetector::new();
        let ev = d.feed(b"\x1b[1;2\x07m");
        assert!(ev.is_empty(), "bytes inside CSI are not bells: {ev:?}");
        assert_eq!(d.feed(b"\x07"), vec![AttentionKind::Bell]);
    }

    #[test]
    fn two_separate_osc_notifications_are_two_events() {
        let mut d = AttentionDetector::new();
        let ev = d.feed(b"\x1b]9;one\x07between\x1b]9;two\x07");
        assert_eq!(ev, vec![AttentionKind::Osc, AttentionKind::Osc]);
    }
}
