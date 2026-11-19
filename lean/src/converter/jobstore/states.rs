//! The states a job file records, as enums: the job's (jobStore.js
//! JOB_STATES), each clip's (ITEM_STATES), a replacement's phase
//! (REPLACEMENT_PHASES) and each owned file's (normalizeOwnedArtifacts).
//! Each is read from the string the file holds and written back as that
//! same string, so a job file stays byte for byte what Node writes. A string
//! none of them knows is kept as read (`Unknown`), never dropped or changed;
//! the store's validation refuses it in a job file, which is then set aside
//! (`job.json.corrupt-*`) as any damaged job file is.
//!
//! `JobState::to` and `ItemState::to` are the moves the service makes: the
//! store refuses any other move of a job or a clip before anything is
//! written (INVALID_STATE_TRANSITION). Phases and owned files' states have
//! no such check: the file transactions record each step they took on disk
//! (backwards too, as when a promotion fails and the backup is let go), and
//! a refused record would leave the job file behind the files.

use super::super::error::CError;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use std::fmt;

/// The code of a refused move.
pub const INVALID_STATE_TRANSITION: &str = "INVALID_STATE_TRANSITION";

/// INVALID_STATE_TRANSITION: `what` cannot move from `from` to `to`.
pub fn refused(what: &str, from: &dyn fmt::Display, to: &dyn fmt::Display) -> CError {
    CError::new(INVALID_STATE_TRANSITION, format!("{what} cannot move from {from} to {to}."))
}

macro_rules! states {
    ($(#[$meta:meta])* $name:ident { $($variant:ident = $text:literal,)+ }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash)]
        pub enum $name {
            $($variant,)+
            /// a string no list knows, kept as read
            Unknown(String),
        }

        impl $name {
            /// Every known one, in Node's order.
            pub const ALL: &'static [$name] = &[$($name::$variant,)+];

            /// The one `s` names (None: a string no list knows).
            pub fn known(s: &str) -> Option<$name> {
                match s {
                    $($text => Some($name::$variant),)+
                    _ => None,
                }
            }

            /// The one `s` names, a string no list knows kept as read.
            pub fn parse(s: &str) -> $name {
                $name::known(s).unwrap_or_else(|| $name::Unknown(s.to_string()))
            }

            /// The string the job file holds.
            pub fn as_str(&self) -> &str {
                match self {
                    $($name::$variant => $text,)+
                    $name::Unknown(s) => s.as_str(),
                }
            }

            pub fn is_known(&self) -> bool {
                !matches!(self, $name::Unknown(_))
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl From<$name> for Value {
            fn from(s: $name) -> Value {
                Value::String(s.as_str().to_string())
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<$name, D::Error> {
                Ok($name::parse(&String::deserialize(d)?))
            }
        }
    };
}

states! {
    /// A job's state (jobStore.js JOB_STATES).
    JobState {
        Discovering = "discovering",
        Waiting = "waiting",
        Staging = "staging",
        Encoding = "encoding",
        WritingTelemetry = "writing-telemetry",
        Verifying = "verifying",
        Copying = "copying",
        Replacing = "replacing",
        Completed = "completed",
        Skipped = "skipped",
        Failed = "failed",
        Paused = "paused",
        PausedNetwork = "paused_network",
        Cancelled = "cancelled",
    }
}

states! {
    /// A clip's state (jobStore.js ITEM_STATES).
    ItemState {
        Queued = "queued",
        Processing = "processing",
        Completed = "completed",
        Skipped = "skipped",
        Failed = "failed",
        Cancelled = "cancelled",
    }
}

states! {
    /// The step a replacement of an original has recorded (jobStore.js
    /// REPLACEMENT_PHASES).
    ReplacementPhase {
        CandidateWritten = "candidate-written",
        OriginalBackedUp = "original-backed-up",
        CandidatePromoted = "candidate-promoted",
        FinalValidated = "final-validated",
        BackupDeleted = "backup-deleted",
        RollbackStarted = "rollback-started",
        BackupRestored = "backup-restored",
        RollbackFailed = "rollback-failed",
    }
}

states! {
    /// What a job file records of a file it owns (artifactMetadata): only
    /// meant (intent), being written, written (owned), or left to remove.
    ArtifactState {
        Intent = "intent",
        Writing = "writing",
        Owned = "owned",
        CleanupPending = "cleanup-pending",
    }
}

impl JobState {
    /// completed, skipped, failed, cancelled (jobStore.js
    /// TERMINAL_JOB_STATES, jobService.js TERMINAL_STATES)
    pub fn is_terminal(&self) -> bool {
        matches!(self, JobState::Completed | JobState::Skipped | JobState::Failed | JobState::Cancelled)
    }

    /// A clip's files are being made or moved: the job names that clip
    /// (jobStore.js TRANSACTION_JOB_STATES).
    pub fn is_transaction(&self) -> bool {
        matches!(self, JobState::Staging | JobState::Encoding | JobState::WritingTelemetry | JobState::Verifying | JobState::Copying | JobState::Replacing)
    }

    /// The steps of a clip's encode: a stop in one is recovered as a stopped
    /// encode, fromState 'encoding' (jobStore.js ENCODING_RECOVERY_STATES).
    pub fn is_encoding_step(&self) -> bool {
        matches!(self, JobState::Staging | JobState::Encoding | JobState::WritingTelemetry | JobState::Verifying)
    }

    /// paused or paused_network
    pub fn is_paused(&self) -> bool {
        matches!(self, JobState::Paused | JobState::PausedNetwork)
    }

    /// Nothing runs: paused or finished (jobService.js IDLE_JOB_STATES).
    pub fn is_idle(&self) -> bool {
        self.is_paused() || self.is_terminal()
    }

    /// Not finished: a job that runs, waits or is paused (jobService.js
    /// ACTIVE_STATES).
    pub fn is_active(&self) -> bool {
        self.is_known() && !self.is_terminal()
    }

    /// Where a wait for the network takes the job back to (jobStore.js
    /// NETWORK_RESUME_STATES).
    pub fn resumes_after_network(&self) -> bool {
        *self == JobState::Waiting || self.is_transaction()
    }

    /// The moves of a job (jobService.js). One not finished (discovering,
    /// waiting, a clip's step, paused, paused_network) goes to any other
    /// state as its clips and the commands take it, but never back to
    /// discovering (only a new job starts there) and never to skipped (a
    /// state Node lists and never sets). A finished one is only retried
    /// (completed or failed to waiting) or cancelled (Cancel ends any job not
    /// cancelled yet, a skipped one too); cancelled is final. Staying in the
    /// same state is no move; a string no list knows never moves or is moved
    /// to.
    pub fn can_become(&self, next: &JobState) -> bool {
        use JobState::*;
        if !self.is_known() || !next.is_known() {
            return false;
        }
        if self == next {
            return true;
        }
        match (self, next) {
            (_, Discovering | Skipped) => false,
            (from, _) if from.is_active() => true,
            (Completed | Failed, Waiting | Cancelled) => true,
            (Skipped, Cancelled) => true,
            _ => false,
        }
    }

    /// `next`, or INVALID_STATE_TRANSITION for a move a job never makes.
    pub fn to(&self, next: JobState) -> Result<JobState, CError> {
        if self.can_become(&next) {
            Ok(next)
        } else {
            Err(refused("The job", self, &next))
        }
    }
}

impl ItemState {
    /// completed, skipped, failed, cancelled (jobService.js TERMINAL_STATES)
    pub fn is_terminal(&self) -> bool {
        matches!(self, ItemState::Completed | ItemState::Skipped | ItemState::Failed | ItemState::Cancelled)
    }

    /// queued or processing: not finished
    pub fn is_in_flight(&self) -> bool {
        matches!(self, ItemState::Queued | ItemState::Processing)
    }

    /// The states discovery adds a clip in: queued, or skipped when it is
    /// converted already.
    pub fn is_initial(&self) -> bool {
        matches!(self, ItemState::Queued | ItemState::Skipped)
    }

    /// The moves of a clip (jobService.js). A queued or processing one goes
    /// back to the queue, starts, or ends any way; a failed one is only
    /// queued again (Retry); completed, skipped and cancelled are final.
    /// Staying in the same state is no move; a string no list knows never
    /// moves or is moved to.
    pub fn can_become(&self, next: &ItemState) -> bool {
        if !self.is_known() || !next.is_known() {
            return false;
        }
        if self == next {
            return true;
        }
        match self {
            ItemState::Queued | ItemState::Processing => true,
            ItemState::Failed => *next == ItemState::Queued,
            _ => false,
        }
    }

    /// `next`, or INVALID_STATE_TRANSITION for a move a clip never makes.
    pub fn to(&self, next: ItemState) -> Result<ItemState, CError> {
        if self.can_become(&next) {
            Ok(next)
        } else {
            Err(refused("A clip", self, &next))
        }
    }
}
