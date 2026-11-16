//! OS access behind a trait, so everything else is testable with the fake. Task 10 adds the rest of
//! the trait (ACL, process checks, window focus) and the real implementations in `hub-platform`.
use std::io;
use std::process::Command;

pub trait Platform: Send + Sync {
    /// Prepares a child command to run without a console window (a no-op outside Windows).
    fn spawn_hidden(&self, cmd: &mut Command);
    /// Kills the process and its children.
    fn kill_tree(&self, pid: u32) -> io::Result<()>;
}

/// For tests: hidden spawn does nothing; `kill_tree` really kills the process (and on Windows its
/// children, through `taskkill /T`), so tests of timeouts and stops end their fake children.
#[derive(Debug, Default, Clone, Copy)]
pub struct FakePlatform;

impl Platform for FakePlatform {
    fn spawn_hidden(&self, _cmd: &mut Command) {}

    fn kill_tree(&self, pid: u32) -> io::Result<()> {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("taskkill");
            c.args(["/PID", &pid.to_string(), "/T", "/F"]);
            c
        } else {
            let mut c = Command::new("kill");
            c.args(["-9", &pid.to_string()]);
            c
        };
        let status = cmd
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!("kill_tree {pid} exited {status}")))
        }
    }
}
