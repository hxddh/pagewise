//! A document the reader opened from outside the app (16.0).
//!
//! Three ways in, one way out:
//!
//! - the command line of this launch (Windows and Linux file associations,
//!   `pagewise paper.pdf`) — kept here until the front end asks for it;
//! - a second launch's command line, handed over by the single-instance
//!   plugin — emitted straight away, the window is already listening;
//! - macOS's "open this file" event, at launch or later — kept here too, and
//!   the front end told to come and take it.
//!
//! The front end takes the pending path once it is ready, so a file that
//! arrives before the webview has loaded is not lost in between.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

/// The first argument after the program that is not a flag, as an absolute
/// path: relative ones are joined to `cwd`.
pub fn path_from_args(argv: &[String], cwd: &Path) -> Option<String> {
    let arg = argv
        .iter()
        .skip(1)
        .find(|a| !a.starts_with('-') && !a.trim().is_empty())?;
    let path = PathBuf::from(arg);
    let path = if path.is_absolute() || cwd.as_os_str().is_empty() {
        path
    } else {
        cwd.join(path)
    };
    Some(path.to_string_lossy().into_owned())
}

#[derive(Default)]
pub struct PendingOpen(Mutex<Option<String>>);

impl PendingOpen {
    pub fn from_launch() -> Self {
        let argv: Vec<String> = std::env::args().collect();
        let cwd = std::env::current_dir().unwrap_or_default();
        Self(Mutex::new(path_from_args(&argv, &cwd)))
    }

    fn set(&self, path: String) {
        if let Ok(mut p) = self.0.lock() {
            *p = Some(path);
        }
    }
}

/// The file the app was asked to open and has not opened yet, once.
#[tauri::command]
pub fn take_pending_open(pending: State<'_, PendingOpen>) -> Option<String> {
    pending.0.lock().ok().and_then(|mut p| p.take())
}

/// macOS: the files of an "open" event. The first one that is a local file.
#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
pub fn opened(app: &AppHandle, urls: &[tauri::Url]) {
    let Some(path) = urls.iter().find_map(|u| u.to_file_path().ok()) else {
        return;
    };
    app.state::<PendingOpen>()
        .set(path.to_string_lossy().into_owned());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit("pagewise://open-pending", ());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reads_the_first_path_after_the_program() {
        let cwd = Path::new("/home/reader");
        assert_eq!(
            path_from_args(&args(&["pagewise", "/docs/a.pdf"]), cwd).as_deref(),
            Some("/docs/a.pdf")
        );
        assert_eq!(
            path_from_args(&args(&["pagewise", "--flag", "/docs/a.pdf"]), cwd).as_deref(),
            Some("/docs/a.pdf")
        );
        assert_eq!(path_from_args(&args(&["pagewise"]), cwd), None);
        assert_eq!(
            path_from_args(&args(&["pagewise", "-psn_0_12345"]), cwd),
            None
        );
    }

    #[test]
    fn joins_a_relative_path_to_the_launch_directory() {
        let got = path_from_args(
            &args(&["pagewise", "paper.pdf"]),
            Path::new("/home/reader/docs"),
        )
        .unwrap();
        assert_eq!(
            PathBuf::from(got),
            Path::new("/home/reader/docs").join("paper.pdf")
        );
    }
}
