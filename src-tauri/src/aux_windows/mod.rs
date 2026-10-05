//! The small always-on-top windows next to the main one — the dictation chip (`overlay`), the
//! quick-add window and the language picker — plus the window helpers they share: placement
//! (`position`), show/hide notices to the webview (`visibility`), the Windows z-order repair
//! (`topmost`) and the KDE/KWin window rules (`kwin`).

#[cfg(target_os = "linux")]
pub mod kwin;
pub mod langpick;
pub mod overlay;
pub mod position;
pub mod quickadd;
#[cfg(windows)]
pub mod topmost;
pub mod visibility;
