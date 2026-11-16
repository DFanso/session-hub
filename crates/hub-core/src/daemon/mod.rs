//! The background daemon's building blocks: the file logger, the single-instance lock, transcript
//! listing and the ingest pass. The collector loop and the run arrive in later tasks.

pub mod ingest_pass;
pub mod lock;
pub mod log;
pub mod transcripts;
