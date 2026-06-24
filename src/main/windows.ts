import { app, BrowserWindow, screen, globalShortcut } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { updateMeeting, getSetting } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let dashboardWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let activeOverlayMeetingId: string | null = null;

export function getDashboardWindow(): BrowserWindow | null {
  return dashboardWindow;
}

export function setDashboardWindow(win: BrowserWindow | null): void {
  dashboardWindow = win;
}

const DEFAULT_SCREENSHOT_HOTKEY = 'CmdOrCtrl+Shift+S';

// Ask the overlay to grab a frame from its already-granted screen stream.
// This reuses the permission acquired at meeting start — no new capture prompt.
function requestScreenshot(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('screenshot:capture-request');
  }
}

export interface RecordingOptions {
  recordAudio?: boolean;
  recordScreen?: boolean;
}

export function createOverlayWindow(meetingId: string, recordingOpts?: RecordingOptions): void {
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }

  const display = screen.getPrimaryDisplay();
  const { width } = display.workAreaSize;
  const winWidth = 880;
  const winHeight = 52; // collapsed horizontal bar; renderer grows it via overlay:resize

  overlayWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: Math.round((width - winWidth) / 2),
    y: 16,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep capturing while briefly hidden for screenshots
    },
  });

  const queryParams: Record<string, string> = { meetingId };
  if (recordingOpts?.recordAudio) queryParams.recordAudio = 'true';
  if (recordingOpts?.recordScreen) queryParams.recordScreen = 'true';

  const isDev = !app.isPackaged;
  if (isDev) {
    const port = process.env.VITE_DEV_PORT || '5174';
    const qs = new URLSearchParams(queryParams).toString();
    overlayWindow.loadURL(`http://localhost:${port}/overlay/index.html?${qs}`);
  } else {
    overlayWindow.loadFile(
      path.join(__dirname, '..', '..', 'renderer', 'overlay', 'index.html'),
      { query: queryParams },
    );
  }

  // Exclude overlay from screen capture / screen sharing
  overlayWindow.setContentProtection(true);

  // Float above everything — fullscreen apps and across all workspaces
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Log renderer console to main process stdout
  overlayWindow.webContents.on('console-message', (_e, level, message) => {
    console.log(`[overlay-renderer] ${message}`);
  });

  activeOverlayMeetingId = meetingId;

  // Register screenshot hotkey (configurable via Settings)
  const hotkey = getSetting('screenshot_hotkey') || DEFAULT_SCREENSHOT_HOTKEY;
  try {
    globalShortcut.register(hotkey, requestScreenshot);
  } catch (err) {
    console.error(`[hotkey] Failed to register "${hotkey}":`, err);
    globalShortcut.register(DEFAULT_SCREENSHOT_HOTKEY, requestScreenshot);
  }

  // Register live-assist intent hotkeys → notify the overlay which intent fired
  const intentHotkeys: [string, string][] = [
    ['intent_answer_hotkey', 'answer'],
    ['intent_suggest_hotkey', 'suggest'],
    ['intent_askback_hotkey', 'askback'],
    ['intent_explain_hotkey', 'explain'],
  ];
  for (const [setting, id] of intentHotkeys) {
    const accel = getSetting(setting);
    if (!accel) continue;
    try {
      globalShortcut.register(accel, () => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('assist:trigger', id);
        }
      });
    } catch (err) {
      console.error(`[hotkey] Failed to register intent "${id}" (${accel}):`, err);
    }
  }

  overlayWindow.on('closed', () => {
    // If closed via OS (Alt+F4, etc.) while still active, clean up meeting status
    if (activeOverlayMeetingId) {
      updateMeeting(activeOverlayMeetingId, { status: 'completed' });
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.webContents.send('meeting:status-changed', activeOverlayMeetingId, 'completed');
      }
      activeOverlayMeetingId = null;
    }
    overlayWindow = null;
  });
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow;
}

// Resize the overlay as its sections expand/collapse. Grows from the current centre so a
// dragged window keeps its place instead of snapping back.
export function resizeOverlayWindow(w: number, h: number): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;
  const [curX, curY] = overlayWindow.getPosition();
  const width = Math.round(w);
  // Anchor the top-left corner (don't re-center) so the bottom-right drag-resize grip
  // tracks the cursor instead of sliding away as the window widens. Clamp onto the screen.
  const x = Math.max(0, Math.min(curX, screenW - width));
  overlayWindow.setBounds({ x, y: curY, width, height: Math.round(h) });
}

export function closeOverlayWindow(): void {
  activeOverlayMeetingId = null;
  globalShortcut.unregisterAll();
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
}
