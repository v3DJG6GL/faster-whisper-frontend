// Which OS the app is running on, for gating Linux-only UI (evdev hotkeys,
// AT-SPI-backed features like per-app rules and deep field detection, Wayland
// copy). The platform is fixed for the lifetime of the process, and both
// desktop WebViews expose it in the user agent (WebKitGTK → "Linux",
// WebView2 → "Windows NT"), so a synchronous constant is enough — no async
// IPC round-trip, no first-paint flash of the wrong controls.
export const IS_LINUX = navigator.userAgent.includes("Linux");
