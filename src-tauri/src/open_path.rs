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

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

/// The first argument after the program that is not a flag (honoring `--` as
/// flag terminator), joined to `cwd` when relative, without panicking on
/// non-UTF-8 OS strings.
pub fn path_from_os_args<I, S>(argv: I, cwd: &Path) -> Option<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut after_terminator = false;
    let mut picked: Option<PathBuf> = None;
    for arg in argv.into_iter().skip(1) {
        let os = arg.as_ref();
        if !after_terminator {
            if os == OsStr::new("--") {
                after_terminator = true;
                continue;
            }
            let lossy = os.to_string_lossy();
            if lossy.starts_with('-') || lossy.trim().is_empty() {
                continue;
            }
        } else if os.is_empty() {
            continue;
        }
        picked = Some(PathBuf::from(os));
        break;
    }
    let path = picked?;
    Some(if path.is_absolute() || cwd.as_os_str().is_empty() {
        path
    } else {
        cwd.join(path)
    })
}

/// String-slice wrapper used by `single_instance` callback and tests.
pub fn path_from_args(argv: &[String], cwd: &Path) -> Option<String> {
    path_from_os_args(argv.iter(), cwd).map(|p| p.to_string_lossy().into_owned())
}

#[derive(Default)]
pub struct PendingOpen(Mutex<Option<PathBuf>>);

#[derive(Default)]
pub struct PendingOpenError(Mutex<Option<String>>);

impl PendingOpen {
    pub fn from_launch() -> Self {
        let cwd = std::env::current_dir().unwrap_or_default();
        Self(Mutex::new(path_from_os_args(std::env::args_os(), &cwd)))
    }

    fn take_path(&self) -> Option<PathBuf> {
        self.0.lock().ok().and_then(|mut p| p.take())
    }

    fn set(&self, path: PathBuf) {
        if let Ok(mut p) = self.0.lock() {
            *p = Some(path);
        }
    }
}

impl PendingOpenError {
    fn set(&self, err: String) {
        if let Ok(mut e) = self.0.lock() {
            *e = Some(err);
        }
    }
}

/// The file the app was asked to open and has not opened yet, once.
#[tauri::command]
pub fn take_pending_open(pending: State<'_, PendingOpen>) -> Option<String> {
    pending
        .take_path()
        .map(|p| crate::grants::for_front_end(&p))
}

/// A coded error from a launch / desktop open that was refused before the
/// webview was listening, read once at startup.
#[tauri::command]
pub fn take_pending_open_error(pending: State<'_, PendingOpenError>) -> Option<String> {
    pending.0.lock().ok().and_then(|mut e| e.take())
}

/// Record and emit a refused desktop/CLI open so the window shows why instead
/// of opening silently empty.
pub fn refuse_open(app: &AppHandle, err: String) {
    app.state::<PendingOpenError>().set(err.clone());
    let _ = app.emit("pagewise://open-refused", err);
}

/// Grant the file this launch was started with (21.0). A path that is not a
/// document records its coded refusal for the front end instead of vanishing.
pub fn grant_pending(app: &AppHandle) {
    let Some(raw) = app.state::<PendingOpen>().take_path() else {
        return;
    };
    match crate::grants::grant_document(app, &raw) {
        Ok(canon) => app.state::<PendingOpen>().set(canon),
        Err(err) => refuse_open(app, err),
    }
}

/// macOS: the files of an "open" event. The first one that is a local file.
#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
pub fn opened(app: &AppHandle, urls: &[tauri::Url]) {
    let Some(path) = urls.iter().find_map(|u| u.to_file_path().ok()) else {
        return;
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    // Granted before the front end is told (21.0).
    match crate::grants::grant_document(app, &path) {
        Ok(canon) => {
            app.state::<PendingOpen>().set(canon);
            let _ = app.emit("pagewise://open-pending", ());
        }
        Err(err) => refuse_open(app, err),
    }
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
        assert_eq!(
            path_from_args(&args(&["pagewise", "--", "-weird-name.pdf"]), cwd).as_deref(),
            Some("/home/reader/-weird-name.pdf")
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
