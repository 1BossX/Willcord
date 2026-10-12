/// Whether this machine is macOS, which picks the trust and install hints. Debug builds let tests choose.
pub(crate) fn is_macos() -> bool {
    #[cfg(debug_assertions)]
    if let Ok(os) = std::env::var("WILLCORD_TEST_OS") {
        return os == "Darwin";
    }
    cfg!(target_os = "macos")
}
