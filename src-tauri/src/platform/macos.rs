//! macOS implementation using public Apple APIs:
//! - NSWorkspace: frontmost app (no permission needed)
//! - CGEventSource: seconds since last input (no permission needed)
//! - Accessibility (AXUIElement): focused window title (needs the user's OK once)
//! - NSRunningApplication.hide: hide a distracting app (no permission needed)

use std::ffi::c_void;
use std::ptr;

use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::string::{CFString, CFStringRef};
use objc2_app_kit::{NSRunningApplication, NSWorkspace};
use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::browser::{browser_kind, parse_tab_output, tab_script, BrowserTab};
use crate::domain::model::ActiveApp;

pub const SUPPORTED: bool = true;

type AXUIElementRef = *const c_void;
type AXError = i32;
const AX_ERROR_SUCCESS: AXError = 0;
/// kCGEventSourceStateCombinedSessionState
const CG_EVENT_SOURCE_STATE_COMBINED: i32 = 0;
/// kCGAnyInputEventType
const CG_ANY_INPUT_EVENT_TYPE: u32 = u32::MAX;
/// Don't let an unresponsive app stall sampling.
const AX_TIMEOUT_SECS: f32 = 0.5;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    static kAXTrustedCheckOptionPrompt: CFStringRef;
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: *mut CFTypeRef) -> AXError;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout_secs: f32) -> AXError;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(source_state: i32, event_type: u32) -> f64;
}

pub fn accessibility_trusted(prompt: bool) -> bool {
    // SAFETY: plain C calls; the options dictionary outlives the call.
    unsafe {
        if !prompt {
            return AXIsProcessTrusted() != 0;
        }
        let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let options = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::true_value().as_CFType())]);
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) != 0
    }
}

/// Copy an AX attribute; the returned CFType owns the reference.
unsafe fn copy_attribute(element: AXUIElementRef, name: &str) -> Option<CFType> {
    let attribute = CFString::new(name);
    let mut value: CFTypeRef = ptr::null();
    let err = AXUIElementCopyAttributeValue(element, attribute.as_concrete_TypeRef(), &mut value);
    if err != AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }
    Some(CFType::wrap_under_create_rule(value))
}

fn focused_window_title(pid: i32) -> Option<String> {
    // SAFETY: AXIsProcessTrusted takes no arguments.
    if unsafe { AXIsProcessTrusted() } == 0 {
        return None;
    }
    // SAFETY: the app element is a CF object we own (create rule) and release via CFType's Drop.
    unsafe {
        let app_ref = AXUIElementCreateApplication(pid);
        if app_ref.is_null() {
            return None;
        }
        let app = CFType::wrap_under_create_rule(app_ref);
        AXUIElementSetMessagingTimeout(app.as_CFTypeRef(), AX_TIMEOUT_SECS);
        let window = copy_attribute(app.as_CFTypeRef(), "AXFocusedWindow")?;
        let title = copy_attribute(window.as_CFTypeRef(), "AXTitle")?;
        let title = title.downcast::<CFString>()?.to_string();
        let title = title.trim();
        (!title.is_empty()).then(|| title.chars().take(300).collect())
    }
}

/// Never let a slow browser stall sampling.
const OSASCRIPT_TIMEOUT: Duration = Duration::from_millis(1500);

/// Run a short AppleScript and return its stdout. The first call per browser makes macOS
/// ask the user to allow Momentum to control it (Automation permission).
fn run_osascript(script: &str) -> Option<String> {
    let mut child = Command::new("/usr/bin/osascript")
        .args(["-e", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + OSASCRIPT_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut out = String::new();
                child.stdout.take()?.read_to_string(&mut out).ok()?;
                return Some(out);
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn active_tab(bundle_id: &str) -> Option<BrowserTab> {
    let kind = browser_kind(bundle_id)?;
    parse_tab_output(&run_osascript(&tab_script(bundle_id, kind))?)
}

pub fn frontmost_app(track_urls: bool) -> Option<ActiveApp> {
    objc2::rc::autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        let app = workspace.frontmostApplication()?;
        let pid = app.processIdentifier();
        let bundle_id = app.bundleIdentifier().map(|s| s.to_string()).unwrap_or_default();
        let name = app
            .localizedName()
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| bundle_id.clone());
        if name.is_empty() && bundle_id.is_empty() {
            return None;
        }
        Some((name, bundle_id, pid))
    })
    .map(|(name, bundle_id, pid)| {
        // Outside the autorelease pool: these can take a moment (Accessibility, osascript).
        let window_title = focused_window_title(pid);
        let tab = if track_urls { active_tab(&bundle_id) } else { None };
        match tab {
            // Private windows: keep nothing about the page, not even its title.
            Some(BrowserTab { incognito: true, .. }) => {
                ActiveApp { name, bundle_id, pid, window_title: None, url: None, incognito: true }
            }
            Some(BrowserTab { url, .. }) => ActiveApp { name, bundle_id, pid, window_title, url, incognito: false },
            None => ActiveApp { name, bundle_id, pid, window_title, url: None, incognito: false },
        }
    })
}

pub fn idle_seconds() -> f64 {
    // SAFETY: plain C call with constant arguments.
    let secs = unsafe { CGEventSourceSecondsSinceLastEventType(CG_EVENT_SOURCE_STATE_COMBINED, CG_ANY_INPUT_EVENT_TYPE) };
    if secs.is_finite() && secs >= 0.0 {
        secs
    } else {
        0.0
    }
}

pub fn hide_app(pid: i32) -> bool {
    if pid <= 0 || pid == std::process::id() as i32 {
        return false;
    }
    objc2::rc::autoreleasepool(|_| {
        NSRunningApplication::runningApplicationWithProcessIdentifier(pid).is_some_and(|app| app.hide())
    })
}

pub fn keep_awake_for_tracking() {
    let info = NSProcessInfo::processInfo();
    let reason = NSString::from_str("Momentum tracks focus time in the background");
    // Lets the display/system sleep normally, but stops App Nap from throttling sampling.
    let token = info.beginActivityWithOptions_reason(NSActivityOptions::UserInitiatedAllowingIdleSystemSleep, &reason);
    // The activity lasts as long as the token lives: keep it for the app's lifetime.
    std::mem::forget(token);
}
