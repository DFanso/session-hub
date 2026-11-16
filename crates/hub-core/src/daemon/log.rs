//! Logging interface of the daemon (port of `Logger` in `src/daemon/log.ts`). The file logger is
//! added with the daemon run loop; only the trait, field types and a test double live here.
//!
//! Never pass message text, prompts, bodies or status text. Only counts, timings, ids, names and
//! error names/messages from our own code.

use std::sync::Mutex;

/// One structured field value.
#[derive(Debug, Clone, PartialEq)]
pub enum LogValue {
    Num(f64),
    Bool(bool),
    Str(String),
}

/// Fields of one log line, in order.
pub type LogFields = Vec<(&'static str, LogValue)>;

pub trait Logger: Send + Sync {
    fn info(&self, event: &str, f: LogFields);
    fn warn(&self, event: &str, f: LogFields);
    fn error(&self, event: &str, f: LogFields);
}

/// One line captured by [`MemoryLogger`].
#[derive(Debug, Clone, PartialEq)]
pub struct LogEntry {
    pub level: &'static str,
    pub event: String,
    pub fields: LogFields,
}

/// Test double that keeps every line in memory. Public (not `cfg(test)`) so integration tests of
/// this and later modules can use it; production code never constructs it.
#[doc(hidden)]
#[derive(Debug, Default)]
pub struct MemoryLogger {
    entries: Mutex<Vec<LogEntry>>,
}

impl MemoryLogger {
    pub fn new() -> MemoryLogger {
        MemoryLogger::default()
    }

    /// Everything logged so far, oldest first.
    pub fn entries(&self) -> Vec<LogEntry> {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn push(&self, level: &'static str, event: &str, fields: LogFields) {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(LogEntry {
                level,
                event: event.to_string(),
                fields,
            });
    }
}

impl Logger for MemoryLogger {
    fn info(&self, event: &str, f: LogFields) {
        self.push("info", event, f);
    }
    fn warn(&self, event: &str, f: LogFields) {
        self.push("warn", event, f);
    }
    fn error(&self, event: &str, f: LogFields) {
        self.push("error", event, f);
    }
}
