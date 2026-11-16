/**
 * Windows system-pointer driver.
 *
 * Electron can move its own window's DOM cursor, but it has no API for the real
 * OS pointer. This module owns a small, persistent PowerShell helper that calls
 * `SetCursorPos` and `mouse_event` in user32.dll. One helper is spawned for the
 * life of the app: spawning PowerShell per frame would cost ~1 s and make the
 * cursor unusable.
 *
 * Everything here is deliberately dumb: the caller supplies physical screen
 * pixels. DPI and display selection stay in the Electron main process, where
 * `screen.dipToScreenPoint` knows the real layout.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from './log.js';

/**
 * The helper compiled by PowerShell on startup. Keep it free of backticks and
 * `${...}`: it lives inside a TypeScript template literal and inside a
 * PowerShell here-string, so those sequences would be interpreted by one of the
 * layers instead of reaching user32.
 */
export const POINTER_AGENT_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
# UI Automation, used to tell whether a text field has focus. Loaded before the
# C# below so HasFocusedTextField can reference the AutomationElement types.
try { Add-Type -AssemblyName UIAutomationClient } catch { }
try { Add-Type -AssemblyName UIAutomationTypes } catch { }
# -ReferencedAssemblies matters: Add-Type does not pick up the UIAutomation
# assemblies from the types referenced in the source, so without this the
# HasFocusedTextField method fails to compile with "System.Windows.Automation
# does not exist" and the whole helper never reaches READY.
Add-Type -Language CSharp -ReferencedAssemblies 'UIAutomationClient','UIAutomationTypes','WindowsBase' @"
using System;
using System.Runtime.InteropServices;
public static class OrbitMouse {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  public class WindowInfo {
    public IntPtr Handle;
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
    public bool Zoomed;
  }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetCursorPos(int X, int Y);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X;
    public int Y;
  }

  [DllImport("user32.dll")]
  public static extern bool GetCursorPos(out POINT p);

  [DllImport("user32.dll")]
  public static extern IntPtr WindowFromPoint(POINT p);

  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool IsZoomed(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

  [ComImport]
  [Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IVirtualDesktopManager {
    [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow, out bool onCurrentDesktop);
    [PreserveSig] int GetWindowDesktopId(IntPtr topLevelWindow, out Guid desktopId);
    [PreserveSig] int MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktopId);
  }

  [ComImport]
  [Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a")]
  class VirtualDesktopManagerCom { }

  public static readonly Guid VIRTUAL_DESKTOP_MANAGER_CLSID =
    new Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a");

  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const byte VK_LWIN = 0x5B;
  public const byte VK_CONTROL = 0x11;
  public const byte VK_LEFT = 0x25;
  public const byte VK_RIGHT = 0x27;
  public const byte VK_H = 0x48;
  public const byte VK_V = 0x56;
  public const byte VK_A = 0x41;
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const int SW_RESTORE = 9;

  /**
   * Switch virtual desktop, exactly like the four-finger trackpad swipe.
   *
   * Windows has no public API for the gesture itself; the trackpad driver sends
   * Win+Ctrl+Left/Right, and so do we. The modifiers are pressed around the
   * arrow and always released, even if the arrow send fails, so a stuck Windows
   * key cannot swallow the user's next shortcut.
   */
  public static void Desktop(int direction) {
    byte arrow = direction < 0 ? VK_LEFT : VK_RIGHT;
    keybd_event(VK_LWIN, 0, 0, UIntPtr.Zero);
    keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
    try {
      keybd_event(arrow, 0, 0, UIntPtr.Zero);
      keybd_event(arrow, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    } finally {
      keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
      keybd_event(VK_LWIN, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }
  }

  /**
   * Toggle Windows voice typing, the same thing Win+H does.
   *
   * Dictation used to be a gesture with nothing behind it: the service emitted
   * dictation.start and the desktop passed it to the renderer, which ignored
   * it. Tapping Win+H is the honest implementation — it uses the dictation
   * engine Windows already has, including its own microphone and language
   * settings, instead of inventing a second one.
   *
   * The key is tapped rather than held so it cannot stick.
   */
  /**
   * True when a control that accepts typing currently has keyboard focus.
   *
   * This is what makes dictation behave like WisprFlow rather than a raw Win+H
   * toggle: with a field focused the transcription should be *pasted into it*,
   * and with nothing focused it should go to the clipboard instead of being
   * typed into whatever window happens to be in front.
   *
   * Read through UI Automation, which reports the real focused element across
   * Win32, WinUI and Electron apps alike. Falls back to "no field" on any error
   * so a failure can never leave the user's text typed somewhere unexpected.
   */
  public static bool HasFocusedTextField() {
    try {
      var focused = System.Windows.Automation.AutomationElement.FocusedElement;
      if (focused == null) return false;
      var patterns = focused.GetSupportedPatterns();
      foreach (var p in patterns) {
        var name = p.ProgrammaticName ?? string.Empty;
        if (name.IndexOf("Value", StringComparison.OrdinalIgnoreCase) >= 0) return true;
        if (name.IndexOf("Text", StringComparison.OrdinalIgnoreCase) >= 0) return true;
      }
      var ct = focused.Current.ControlType;
      if (ct == System.Windows.Automation.ControlType.Edit) return true;
      if (ct == System.Windows.Automation.ControlType.Document) return true;
      return false;
    } catch {
      return false;
    }
  }

  /** Paste whatever is on the clipboard into the focused control (Ctrl+V). */
  public static void PasteKeys() {
    keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
    try {
      keybd_event(VK_V, 0, 0, UIntPtr.Zero);
      keybd_event(VK_V, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    } finally {
      keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }
  }

  public static void Dictation() {
    keybd_event(VK_LWIN, 0, 0, UIntPtr.Zero);
    try {
      keybd_event(VK_H, 0, 0, UIntPtr.Zero);
      keybd_event(VK_H, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    } finally {
      keybd_event(VK_LWIN, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }
  }

  /**
   * Keep a window on whatever desktop is current, so switching desktops does
   * not strand it.
   *
   * ORBIT is a second screen for the machine: the user switches desktop to work
   * and expects ORBIT to still be there, still controlling things. Without this
   * the Win+Ctrl+Arrow that the left-hand swipe sends moved ORBIT away together
   * with everything else, so after one switch the app was on a desktop the user
   * was not looking at — "the app is running on this desktop so it doesn't work
   * anymore".
   *
   * Implemented by moving the window onto the *current* desktop id. Windows has
   * no public "always visible on all desktops" flag, so this is re-applied after
   * each switch rather than set once.
   */
  public static bool PinToCurrentDesktop(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return false;
    try {
      var mgr = (IVirtualDesktopManager)Activator.CreateInstance(
        Type.GetTypeFromCLSID(VIRTUAL_DESKTOP_MANAGER_CLSID));
      bool onCurrent;
      int hr = mgr.IsWindowOnCurrentVirtualDesktop(hWnd, out onCurrent);
      if (hr != 0) return false;
      if (onCurrent) return true;
      // Map the foreground window's desktop and move our window onto it.
      IntPtr fg = GetForegroundWindow();
      if (fg == IntPtr.Zero) return false;
      Guid desktopId;
      hr = mgr.GetWindowDesktopId(fg, out desktopId);
      if (hr != 0) return false;
      hr = mgr.MoveWindowToDesktop(hWnd, ref desktopId);
      return hr == 0;
    } catch {
      return false;
    }
  }

  /** The window a grab is currently moving, or zero. */
  public static IntPtr Target = IntPtr.Zero;

  // Deliberately NOT made DPI-aware.
  //
  // A DPI-unaware process accepts and reports cursor coordinates in the
  // virtualised logical space (1536x864 on a 1920x1080 display at 125%).
  // Electron's Display.bounds is in exactly that space, so the coordinates we
  // compute need no conversion and agree 1:1 with SetCursorPos and
  // GetWindowRect/SetWindowPos in this same helper.
  //
  // Calling SetThreadDpiAwarenessContext here was the bug: it succeeds, but then
  // the same numbers are interpreted as *physical* pixels, so every click landed
  // 1.25x further right and down than intended — usually off-screen, where it
  // clicked nothing. See toScreenPoint in ipc.ts for the matching half.
  public static bool MakeDpiAware() {
    return SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero;
  }

  public static void Move(int x, int y) {
    SetCursorPos(x, y);
  }

  public static void Down() {
    // Let the shell finish processing the move before the button goes down.
    //
    // Reported: "Still when i try to click something on taskbar, it only worked
    // once with google chrome. Other times it doesn't work."
    //
    // The Windows 11 taskbar is not a Win32 control: it is a XAML surface hosted
    // in a Windows.UI.Composition.DesktopWindowContentBridge. That input stack
    // routes a press to whatever element it considers hovered, and hover is
    // established from the pointer *move* - which arrives in the same batch as
    // the press when they are sent back to back. The shell therefore saw the
    // press before it had registered the hover and discarded it, which is why
    // clicking worked only by luck.
    //
    // A short pause between the move and the press is enough for the hover to
    // land. It is invisible during a normal click and is the difference between
    // the taskbar responding every time and almost never.
    System.Threading.Thread.Sleep(25);
    mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
  }

  public static void Up() {
    mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero);
  }

  /**
   * A full click: press, hold briefly, release.
   *
   * Reported: "whenever i try clicking on the taskbar to open an app it doesn't
   * work. I can see it clicking but it doesn't open."
   *
   * Down and Up were sent back-to-back with no gap at all. The taskbar
   * (and a fair number of other controls) only commit a click when the button is
   * genuinely held for a moment - with a zero-length press it receives the down
   * and the up in the same message pump turn and treats it as a stray event, so
   * the button highlights but nothing opens. A human click is 60-120 ms; 40 ms
   * is below what anyone would notice as lag and above what the shell needs to
   * register the press as real.
   */
  public static void Click() {
    Down();
    System.Threading.Thread.Sleep(40);
    Up();
  }

  /** One notch is 120 units; a positive value scrolls up (away from the user). */
  public static void Wheel(int notches) {
    if (notches == 0) return;
    int delta = notches * 120;

    // mouse_event delivers the wheel to the window with keyboard focus. While
    // the user watches the Gestures page that is ORBIT, so the wheel turned but
    // the page under the hand never moved. Send the message to the window that
    // is actually under the pointer instead: that is the page the gesture is
    // aimed at. Coordinates are in this process's DPI-virtualised space, the
    // same space the pointer frame and the window rect use.
    //
    // The method must NOT be named the same as a constant ignoring case:
    // PowerShell resolves members case-insensitively, so a method Wheel and a
    // const WHEEL collide and every call throws "does not contain a method
    // named Wheel" — which the caller's catch swallowed, so the wheel silently
    // never turned.
    POINT p;
    if (GetCursorPos(out p)) {
      IntPtr child = WindowFromPoint(p);
      IntPtr root = child == IntPtr.Zero ? IntPtr.Zero : GetAncestor(child, 2);
      if (root != IntPtr.Zero) {
        // HIWORD of wParam is the signed wheel delta; LOWORD is key state.
        IntPtr wParam = new IntPtr(unchecked((int)((uint)delta << 16)));
        IntPtr lParam = new IntPtr(unchecked((p.Y << 16) | (p.X & 0xFFFF)));
        IntPtr result;
        // Bounded: a hung app must not stall the pointer helper.
        IntPtr ok = SendMessageTimeout(root, 0x020A, wParam, lParam, 0x0002 | 0x0001, 100, out result);
        if (ok != IntPtr.Zero) return;
      }
    }

    mouse_event(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)delta), UIntPtr.Zero);
  }

  public static bool IsCandidate(IntPtr h, uint ownPid) {
    if (h == IntPtr.Zero || !IsWindowVisible(h) || IsIconic(h)) return false;
    // A titled, reasonably sized top-level window. This skips tooltips, the
    // desktop, and the invisible helper windows every app creates.
    if (GetWindowTextLength(h) == 0) return false;
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    if (pid == ownPid) return false;
    RECT r;
    if (!GetWindowRect(h, out r)) return false;
    if ((r.Right - r.Left) < 120 || (r.Bottom - r.Top) < 80) return false;
    return true;
  }

  /** The topmost visible, titled window that is not one of our own. */
  public static IntPtr FindForeign(uint ownPid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsCandidate(h, ownPid)) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  /**
   * Pick the window to move. The foreground window is the natural target. When
   * ORBIT itself is focused — which is exactly what happens while the user is
   * watching the Gestures page — fall back to the topmost other window so the
   * gesture still has something to grab.
   */
  public static WindowInfo Grab(uint ownPid) {
    IntPtr h = GetForegroundWindow();
    if (!IsCandidate(h, ownPid)) h = FindForeign(ownPid);
    if (h == IntPtr.Zero) return null;

    bool zoomed = IsZoomed(h);
    if (zoomed) ShowWindow(h, SW_RESTORE);

    RECT r;
    if (!GetWindowRect(h, out r)) return null;

    Target = h;
    WindowInfo info = new WindowInfo();
    info.Handle = h;
    info.Left = r.Left;
    info.Top = r.Top;
    info.Right = r.Right;
    info.Bottom = r.Bottom;
    info.Zoomed = zoomed;
    return info;
  }

  public static void MoveTarget(int x, int y) {
    if (Target == IntPtr.Zero) return;
    // Validate before touching it.
    //
    // Reported: "when I tried to click the minimize button on the app it always
    // crashes."
    //
    // Target is captured once when the window is grabbed and then reused for
    // every frame of the drag. Minimising or closing that window frees its
    // handle, and SetWindowPos against a freed handle is undefined behaviour
    // inside the shell - it takes the helper process down, which in turn kills
    // the pipe the app is writing to. IsWindow is the standard liveness check and
    // costs nothing; when it fails the grab is simply over.
    if (!IsWindow(Target)) {
      Target = IntPtr.Zero;
      return;
    }
    SetWindowPos(Target, IntPtr.Zero, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
  }

  public static void ReleaseTarget() {
    Target = IntPtr.Zero;
  }
}
"@
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  if ($line -eq 'Q') { break }
  if ($line -eq 'C') { [OrbitMouse]::Click(); continue }
  if ($line -eq 'D') { [OrbitMouse]::Down(); continue }
  if ($line -eq 'U') { [OrbitMouse]::Up(); continue }
  if ($line -eq 'E') { [OrbitMouse]::ReleaseTarget(); continue }
  if ($line -eq 'T') {
    try { [Console]::Out.WriteLine('TEXTFIELD ' + [OrbitMouse]::HasFocusedTextField()) }
    catch { [Console]::Out.WriteLine('TEXTFIELD False') }
    [Console]::Out.Flush()
    continue
  }
  if ($line -eq 'V') { [OrbitMouse]::PasteKeys(); continue }
  if ($line -eq 'H') {
    try {
      [OrbitMouse]::Dictation()
    } catch {
      [Console]::Error.WriteLine('ORBIT pointer helper: dictation failed: ' + $_)
    }
    continue
  }
  if ($line.StartsWith('K ')) {
    try {
      [OrbitMouse]::Desktop([int]$line.Substring(2).Trim())
    } catch {
      [Console]::Error.WriteLine('ORBIT pointer helper: desktop switch failed: ' + $_)
    }
    continue
  }
  if ($line.StartsWith('Z ')) {
    try {
      # Re-pinning is best effort and repeatable, so it answers with nothing.
      # A reply would need a parser on the other side for no benefit: a failure
      # simply leaves the window where it was.
      $hwnd = [IntPtr][int64]$line.Substring(2).Trim()
      [void][OrbitMouse]::PinToCurrentDesktop($hwnd)
    } catch {
      [Console]::Error.WriteLine('ORBIT pointer helper: pin failed: ' + $_)
    }
    continue
  }
  if ($line.StartsWith('M ')) {
    $parts = $line.Substring(2).Split(' ')
    if ($parts.Length -ge 2) {
      try {
        [OrbitMouse]::Move([int]$parts[0], [int]$parts[1])
      } catch {
        [Console]::Error.WriteLine('ORBIT pointer helper: move failed: ' + $_)
      }
    }
    continue
  }
  if ($line.StartsWith('S ')) {
    $parts = $line.Substring(2).Split(' ')
    if ($parts.Length -ge 1) {
      try {
        [OrbitMouse]::Wheel([int]$parts[0])
      } catch {
        # Never swallow this silently: a missing method here once meant every
        # scroll command did nothing while the helper stayed healthy.
        [Console]::Error.WriteLine('ORBIT pointer helper: wheel failed: ' + $_)
      }
    }
    continue
  }
  if ($line.StartsWith('G ')) {
    $ownPid = [uint32]0
    try {
      $ownPid = [uint32]$line.Substring(2).Trim()
    } catch { }
    $info = [OrbitMouse]::Grab($ownPid)
    if ($null -eq $info) {
      [Console]::Out.WriteLine('NOWINDOW')
    } else {
      $zoomed = '0'
      if ($info.Zoomed) { $zoomed = '1' }
      [Console]::Out.WriteLine('W ' + $info.Handle.ToInt64().ToString() + ' ' + $info.Left + ' ' + $info.Top + ' ' + $info.Right + ' ' + $info.Bottom + ' ' + $zoomed)
    }
    [Console]::Out.Flush()
    continue
  }
  if ($line.StartsWith('P ')) {
    $parts = $line.Substring(2).Split(' ')
    if ($parts.Length -ge 2) {
      try {
        [OrbitMouse]::MoveTarget([int]$parts[0], [int]$parts[1])
      } catch { }
    }
  }
}
`;

const SPAWN_READY_TIMEOUT_MS = 4000;

/**
 * How far the real cursor may travel while the left button is down before the
 * pinch is treated as a drag instead of a click.
 *
 * Reported: *"It also almost never works when I click any app icon in the
 * taskbar."* A pinch held to click also keeps sending pointer frames, and those
 * frames used to move the cursor between the press and the release. A taskbar
 * icon is about 40 px wide: a few pixels of landmark jitter was enough to slide
 * off the icon or start a drag, and Explorer then never fired the launch. The
 * cursor now stays exactly where the press happened until the movement is
 * deliberate.
 */
const DRAG_THRESHOLD_PX = 12;

/**
 * Longer grace right after the press.
 *
 * Pinching itself moves the palm slightly, and the smoothing catches up over a
 * couple of frames. During this window only a clearly deliberate movement
 * (four times the normal threshold) starts a drag, so the click lands where the
 * user aimed even if the hand shifts as the fingers close.
 */
const CLICK_SETTLE_MS = 150;
const CLICK_SETTLE_PX = DRAG_THRESHOLD_PX * 4;

/** Do not let an unresponsive helper grow an unbounded write queue. */
const MAX_STDIN_BACKLOG = 32 * 1024;

/** A real Windows window the helper is currently moving. */
export interface WindowTarget {
  /** Decimal HWND, kept as a string so it never loses precision in a double. */
  hwnd: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** True when the window was maximised and had to be restored to move it. */
  zoomed: boolean;
}

export class SystemPointer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private disposed = false;
  private pending: string[] = [];
  private last = { x: Number.NaN, y: Number.NaN };
  /** True while we have sent a mouse-down that has not been matched by an up. */
  private pressed = false;
  /** Where the cursor was when the current press started. */
  private pressPoint: { x: number; y: number } | null = null;
  private pressedAt = 0;
  /** Set once a press has moved far enough to be a real drag. */
  private dragging = false;
  /** Throttle for the "helper backlog" warning. */
  private backlogLoggedAt = 0;
  /** The outstanding `G` window-grab request, if any. */
  private grabResolve: ((target: WindowTarget | null) => void) | null = null;
  private textFieldResolve: ((focused: boolean) => void) | null = null;

  constructor(private readonly scriptPath: string) {}

  get supported(): boolean {
    return process.platform === 'win32';
  }

  /**
   * Move the real pointer to physical pixel coordinates.
   *
   * Only a change of target is sent. Re-asserting the same position on a timer
   * would fight the physical mouse: a user who reaches for it while the hand is
   * still in view would find the cursor pulled back every quarter second. The
   * hand reclaims the pointer naturally on its next movement instead.
   */
  move(x: number, y: number): void {
    if (!this.supported || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const px = Math.round(x);
    const py = Math.round(y);
    if (px === this.last.x && py === this.last.y) return;

    // While a press is held, a little movement is the hand shaking, not a drag.
    // Ignoring it keeps a pinch-click a click: the cursor stays on the icon (or
    // button, or menu item) it was pressed on until the user really moves.
    if (this.pressed && !this.dragging && this.pressPoint) {
      const dx = px - this.pressPoint.x;
      const dy = py - this.pressPoint.y;
      const distance = Math.hypot(dx, dy);
      const settling = Date.now() - this.pressedAt < CLICK_SETTLE_MS;
      const limit = settling ? CLICK_SETTLE_PX : DRAG_THRESHOLD_PX;
      if (distance < limit) return;
      this.dragging = true;
      log.debug('pointer', 'Press became a drag.', { from: this.pressPoint, to: { x: px, y: py } });
    }

    this.last = { x: px, y: py };
    this.send(`M ${px} ${py}`);
  }

  /** Put the pointer at a physical pixel position and hold the left button. */
  press(x: number, y: number): void {
    if (!this.supported) return;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const px = Math.round(x);
      const py = Math.round(y);
      this.last = { x: px, y: py };
      this.pressPoint = { x: px, y: py };
      this.send(`M ${px} ${py}`);
    }
    if (this.pressed) return;
    this.pressed = true;
    this.pressedAt = Date.now();
    this.dragging = false;
    this.send('D');
  }

  /** Release the left button. Safe to call when it is already up. */
  release(): void {
    if (!this.pressed) return;
    this.pressed = false;
    this.pressPoint = null;
    this.dragging = false;
    this.send('U');
  }

  /**
   * Put the pointer at a physical pixel position and left-click there.
   *
   * The helper's `C` command is a press with a real hold (25 ms for the hover to
   * register, then 40 ms down). Sending `D` and `U` back to back is not a click:
   * the shell receives both in the same message turn and treats it as a stray
   * event, which is why the legacy one-shot path could highlight a taskbar icon
   * without opening it.
   */
  click(x: number, y: number): void {
    if (!this.supported) return;
    if (this.pressed) {
      this.release();
      return;
    }
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const px = Math.round(x);
      const py = Math.round(y);
      this.last = { x: px, y: py };
      this.send(`M ${px} ${py}`);
    }
    this.send('C');
  }

  /**
   * Turn the real mouse wheel. Positive notches scroll up, matching Windows'
   * `MOUSEEVENTF_WHEEL` convention.
   */
  wheel(notches: number): void {
    if (!this.supported) return;
    const n = Math.trunc(notches);
    if (!Number.isFinite(n) || n === 0) return;
    this.send(`S ${n}`);
  }

  /**
   * Switch virtual desktop by one step. `1` is the next desktop to the right,
   * `-1` the previous one, the same direction the four-finger swipe moves.
   */
  switchDesktop(direction: 1 | -1): void {
    if (!this.supported) return;
    this.send(`K ${direction}`);
  }

  /** Toggle Windows voice typing (Win+H) for the dictation gesture. */
  toggleDictation(): void {
    if (!this.supported) return;
    this.send('H');
  }

  /**
   * Ask whether a text field has keyboard focus, so dictation can decide
   * between pasting into it and copying instead.
   *
   * Resolves `false` on any failure or timeout: the safe default is the
   * clipboard, because pasting into the wrong window would type the user's
   * speech somewhere they did not ask for.
   */
  hasFocusedTextField(): Promise<boolean> {
    if (!this.supported) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        if (this.textFieldResolve === finish) this.textFieldResolve = null;
        resolve(value);
      };
      this.textFieldResolve = finish;
      this.send('T');
      const timer = setTimeout(() => finish(false), 800);
      timer.unref?.();
    });
  }

  /** Paste the clipboard into the focused control (Ctrl+V). */
  paste(): void {
    if (!this.supported) return;
    this.send('V');
  }

  /**
   * Bring a window onto the desktop the user is looking at.
   *
   * `hwnd` is Windows' `BrowserWindow.getNativeWindowHandle()` read as a
   * little-endian integer. Returns `false` when the helper could not do it, so
   * the caller can stay quiet instead of claiming a pin that did not happen.
   */
  pinToCurrentDesktop(hwnd: bigint): void {
    if (!this.supported || hwnd === 0n) return;
    this.send(`Z ${hwnd.toString()}`);
  }

  /**
   * Ask the helper which window a fist should move.
   *
   * Resolves to the foreground window, or the topmost other window when ORBIT
   * itself is focused. `ownerPid` is skipped so a grab never drags ORBIT's own
   * window as a side effect of testing the gesture on the Gestures page.
   */
  grabWindow(ownerPid: number): Promise<WindowTarget | null> {
    if (!this.supported) return Promise.resolve(null);
    // Only one grab can be outstanding; a newer one supersedes it.
    const previous = this.grabResolve;
    this.grabResolve = null;
    previous?.(null);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (target: WindowTarget | null): void => {
        if (settled) return;
        settled = true;
        if (this.grabResolve === finish) this.grabResolve = null;
        resolve(target);
      };
      this.grabResolve = finish;
      this.send(`G ${Math.round(ownerPid)}`);
      const timer = setTimeout(() => finish(null), 1500);
      timer.unref?.();
    });
  }

  /** Move the grabbed window's top-left corner, in DIP screen pixels. */
  moveWindow(x: number, y: number): void {
    if (!this.supported) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.send(`P ${Math.round(x)} ${Math.round(y)}`);
  }

  /** Stop moving the grabbed window. Safe to call when nothing is grabbed. */
  endWindowMove(): void {
    if (!this.supported) return;
    this.send('E');
  }

  /** Stop the helper. Safe to call more than once. */
  dispose(): void {
    this.disposed = true;
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.pressed = false;
    this.pressPoint = null;
    this.dragging = false;
    this.pending = [];
    const grab = this.grabResolve;
    this.grabResolve = null;
    grab?.(null);
    if (!child) return;
    log.info('pointer', 'Stopping the pointer helper.', { pid: child.pid });
    try {
      // Always send an up before quitting: a helper that exits mid-drag would
      // leave the left button logically down across the whole desktop.
      child.stdin.write('U\nE\nQ\n');
    } catch {
      /* already gone */
    }
    // A wedged helper must not outlive the app; killing after a short grace is
    // better than leaving a process that can move the user's pointer.
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, 500);
    timer.unref?.();
  }

  /**
   * Parse a line the helper wrote after READY. The only unsolicited reply is
   * the answer to `G`, which is either `NOWINDOW` or
   * `W <hwnd> <left> <top> <right> <bottom> <zoomed>`.
   */
  private handleLine(line: string): void {
    if (line.startsWith('TEXTFIELD ')) {
      const resolve = this.textFieldResolve;
      this.textFieldResolve = null;
      resolve?.(line.slice('TEXTFIELD '.length).trim() === 'True');
      return;
    }
    if (line === 'NOWINDOW') {
      const resolve = this.grabResolve;
      this.grabResolve = null;
      resolve?.(null);
      return;
    }
    if (!line.startsWith('W ')) {
      // Anything else is unexpected. Log it: a helper that starts answering a
      // command with a new string would otherwise fail silently for ever.
      log.debug('pointer', `Helper said: ${line.slice(0, 400)}`);
      return;
    }
    const parts = line.slice(2).trim().split(/\s+/);
    if (parts.length < 6) return;
    const hwnd = parts[0]!;
    const nums = parts.slice(1, 6).map((part) => Number(part));
    if (nums.some((n) => !Number.isFinite(n))) return;
    const [left, top, right, bottom, zoomed] = nums as [
      number,
      number,
      number,
      number,
      number,
    ];
    const resolve = this.grabResolve;
    this.grabResolve = null;
    resolve?.({ hwnd, left, top, right, bottom, zoomed: zoomed !== 0 });
  }

  private send(line: string): void {
    if (this.disposed) return;
    this.ensure();
    if (!this.child) return;
    if (!this.ready) {
      // Keep only the newest movement so a slow first start does not replay a
      // second of old positions before the latest one. Button transitions are
      // kept in order: dropping a press or its release would leave a drag open.
      if (line.startsWith('M ') || line.startsWith('P ')) {
        const last = this.pending.length - 1;
        if (last >= 0 && this.pending[last]!.startsWith(line.slice(0, 2))) this.pending[last] = line;
        else this.pending.push(line);
      } else {
        this.pending.push(line);
        // Bound the queue. Drop the oldest movement first; button events are
        // what keep the desktop consistent.
        if (this.pending.length > 24) {
          const move = this.pending.findIndex((l) => l.startsWith('M '));
          if (move >= 0) this.pending.splice(move, 1);
          else this.pending.shift();
        }
      }
      return;
    }

    // A helper that is stuck in a user32 call cannot read its pipe. Node then
    // buffers every write in memory, and because the cursor moves on almost
    // every frame the queue grows without bound until the app runs out of
    // memory - one of the ways this app used to freeze after a long session.
    // Movement is disposable: drop it and let the next frame carry the current
    // position. Button transitions are never dropped.
    const backlog = this.child.stdin.writableLength;
    if (backlog > MAX_STDIN_BACKLOG && (line.startsWith('M ') || line.startsWith('P '))) {
      const now = Date.now();
      if (now - this.backlogLoggedAt > 5_000) {
        this.backlogLoggedAt = now;
        log.warn('pointer', 'Pointer helper is not reading its input; dropping movement.', {
          backlog_bytes: backlog,
        });
      }
      return;
    }

    this.write(line);
  }

  private write(line: string): void {
    const child = this.child;
    // `destroyed` and `writableEnded` are the only reliable signals that the
    // pipe is closed before the 'error' event has been delivered. Checking them
    // keeps a pinch after a helper restart from writing at all, instead of
    // relying on the error handler to clean up afterwards.
    if (!child || child.stdin.destroyed || child.stdin.writableEnded) {
      this.child = null;
      this.ready = false;
      return;
    }
    try {
      child.stdin.write(`${line}\n`);
    } catch {
      this.child = null;
      this.ready = false;
    }
  }

  private ensure(): void {
    if (!this.supported || this.disposed) return;
    if (this.child && this.child.exitCode === null && !this.child.killed) return;

    try {
      mkdirSync(dirname(this.scriptPath), { recursive: true, mode: 0o700 });
      writeFileSync(this.scriptPath, POINTER_AGENT_SOURCE, { mode: 0o600 });
    } catch {
      return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.scriptPath,
        ],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {
      return;
    }

    this.child = child;
    this.ready = false;

    let readyTimer: NodeJS.Timeout | null = setTimeout(() => {
      readyTimer = null;
      // No READY line: the helper is not safe to use. Kill it and let the next
      // move retry from scratch instead of queueing forever.
      if (!this.ready) {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
    }, SPAWN_READY_TIMEOUT_MS);
    readyTimer.unref?.();

    child.stdout.setEncoding('utf8');
    let output = '';
    child.stdout.on('data', (chunk: string) => {
      // An old child can outlive a replacement for a moment; only the current
      // one may flip readiness or answer a grab.
      if (this.child !== child) return;
      output += chunk;
      let newline: number;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline).replace(/\r$/, '').trim();
        output = output.slice(newline + 1);
        if (!line) continue;
        if (!this.ready && line === 'READY') {
          this.ready = true;
          if (readyTimer) {
            clearTimeout(readyTimer);
            readyTimer = null;
          }
          for (const queued of this.pending) this.write(queued);
          this.pending = [];
          continue;
        }
        this.handleLine(line);
      }
      // Do not grow unbounded if the helper ever writes noise before READY.
      if (!this.ready && output.length > 4096) output = output.slice(-64);
    });
    // Nothing useful goes to stderr; draining it prevents a full pipe from
    // blocking the helper.
    child.stderr.resume();
    child.on('error', () => {
      if (this.child === child) {
        this.child = null;
        this.ready = false;
      }
    });
    child.on('exit', () => {
      if (this.child === child) {
        this.child = null;
        this.ready = false;
      }
    });

    // A dead pipe must never take the app down.
    //
    // Reported: "when I disable control of mouse pointer with hand to recenter
    // cursor and then enable it back, and then pinch, the app just crashes.
    // Everything just freezes and I have to close and reopen it."
    //
    // Disabling and re-enabling replaces the helper. The replacement takes a
    // moment to print READY, and a pinch in that window writes to the *old*
    // child's stdin — which is already gone. `stdin.write` to a closed pipe
    // emits `EPIPE` as an error *event on the stream*, not as a thrown error, so
    // the try/catch around the write never saw it. An unhandled 'error' event on
    // a stream is fatal in Node, and in Electron it takes the whole main process
    // with it: the window stops responding and the app has to be restarted.
    //
    // Handled here, on every stream, so any broken pipe is treated as "the
    // helper is gone" and the next send simply respawns it.
    const forgetChild = (): void => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = false;
    };
    child.stdin.on('error', forgetChild);
    child.stdout.on('error', forgetChild);

    // Writing to a pipe nobody is reading fills it and blocks the event loop.
    // Ignore backpressure rather than waiting: a missed pointer move is
    // harmless, and the next frame carries the current position anyway.
    child.stdin.on('drain', () => {});
  }
}
