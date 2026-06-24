import { app, BrowserWindow, Menu, protocol } from 'electron';
import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { initDatabase } from './database.js';
import { ensureBaseDir } from './file-manager.js';
import { registerIpcHandlers, summarizeMissingMeetings, fsPathAllowed } from './ipc-handlers.js';
import { setDashboardWindow } from './windows.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createDashboardWindow(): void {
  // Remove default menu
  Menu.setApplicationMenu(null);

  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Echolect',
    icon: path.join(app.getAppPath(), 'logo-mark.png'),
    show: false,
  });

  setDashboardWindow(win);

  win.once('ready-to-show', () => {
    win.maximize();   // open using the full screen, not a small centered window
    win.show();
  });

  // In dev, load from Vite dev server; in prod, load built files
  const isDev = !app.isPackaged;
  if (isDev) {
    const port = process.env.VITE_DEV_PORT || '5174';
    win.loadURL(`http://localhost:${port}/dashboard/index.html`);
  } else {
    win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'dashboard', 'index.html'));
  }

  win.on('closed', () => {
    setDashboardWindow(null);
  });
}

// Register custom protocol to serve local media files
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { bypassCSP: true, stream: true, supportFetchAPI: true } },
]);

app.whenReady().then(() => {
  // Handle media:// URLs — serve a local file with HTTP Range support so <video>/<audio> can
  // SEEK (without 206 Partial Content responses the player snaps back to the buffered position).
  protocol.handle('media', (request) => {
    const filePath = decodeURIComponent(request.url.replace('media://', ''));
    if (!fsPathAllowed(filePath)) return new Response(null, { status: 403 });  // no arbitrary file reads
    let total: number;
    try { total = fs.statSync(filePath).size; } catch { return new Response(null, { status: 404 }); }

    const ext = path.extname(filePath).toLowerCase();
    const type = ext === '.webm' ? 'video/webm' : ext === '.mp4' ? 'video/mp4'
      : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : 'application/octet-stream';

    const toBody = (s: import('fs').ReadStream) => Readable.toWeb(s) as unknown as ReadableStream<Uint8Array>;
    const range = request.headers.get('range');
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= total) end = total - 1;
      if (start > end) { start = 0; end = total - 1; }
      return new Response(toBody(fs.createReadStream(filePath, { start, end })), {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
        },
      });
    }
    return new Response(toBody(fs.createReadStream(filePath)), {
      status: 200,
      headers: { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(total) },
    });
  });

  initDatabase();
  ensureBaseDir();

  registerIpcHandlers();
  createDashboardWindow();

  // Catch up any completed meeting whose summary never got generated (app closed mid-summary,
  // or the CLI was misconfigured). Runs in the background after the window is up.
  summarizeMissingMeetings().catch((err) => console.error('[catch-up] error:', err));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createDashboardWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
