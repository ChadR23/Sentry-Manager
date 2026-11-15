//! The converter (src/main/converter/ and server/converter*.js), ported
//! piece by piece with every safety check, in the same order. See
//! lean/PORT_PLAN.md ("Converter") for what is done and what is left.
//!
//! Layers, bottom up:
//! - `owned`: the only ways a file the converter did not just create is
//!   removed or renamed (identity + SHA-256 with the file held open,
//!   quarantine rename, renameat2 RENAME_NOREPLACE).
//! - `mp4w`, `tesla_sei`, `timeline`, `lead_in`, `frame_num`, `h265`, `av1`,
//!   `adapters`: reading the original's telemetry and writing it into the
//!   encode, byte for byte as the Node code writes it.

pub mod adapters;
pub mod av1;
pub mod contracts;
pub mod ctx;
pub mod error;
pub mod frame_num;
pub mod h265;
pub mod ipc;
pub mod jobstore;
pub mod lead_in;
pub mod mp4w;
pub mod owned;
pub mod planner;
pub mod process;
pub mod recovery;
pub mod runtime;
pub mod scanner;
pub mod service;
pub mod snapshot;
pub mod staging;
pub mod tesla_sei;
pub mod timeline;
pub mod verifier;

#[cfg(test)]
mod tests;
