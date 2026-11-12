const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { chromium } = require('playwright');

const PORT = Number(process.env.PORT) || 17890;
const MAX_TEXT_BODY = 2 * 1024 * 1024; // 2MB
const MAX_IMAGE_BODY = 1024 * 1024; // 1MB
const MAX_WS_FRAME = 64 * 1024;
const MAX_WS_FRAMES = 2000;

const UI_HTML = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');
const ICON_SVG = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.svg'), 'utf8');

// ---------------- State ----------------
let browser = null;
let session = null; // { url, startedAt }
let seq = 0;
const entries = new Map(); // id -> entry
const reqIds = new WeakMap(); // playwright Request -> id
const clients = new Set(); // SSE responses

const now = () => Date.now();

function summary(e) {
  return {
    id: e.id, kind: e.kind, method: e.method, url: e.url, type: e.type,
    status: e.status, statusText: e.statusText, state: e.state, error: e.error,
    mimeType: e.mimeType, size: e.size, startedAt: e.startedAt, duration: e.duration,
    frameCount: e.frames ? e.frames.length : undefined,
  };
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
const pushEntry = (e) => broadcast('entry', summary(e));

// ---------------- Body helpers ----------------
const isText = (mime) => /^(text\/|application\/(json|javascript|x-javascript|ecmascript|xml|xhtml\+xml|x-www-form-urlencoded|graphql|ld\+json|manifest\+json)|image\/svg\+xml)|\+json|\+xml/i.test(mime || '');
const isImage = (mime) => /^image\//i.test(mime || '');

async function readBody(res, mime) {
  try {
    const buf = await res.body();
    if (isText(mime)) {
      const text = buf.toString('utf8');
      return { body: text.slice(0, MAX_TEXT_BODY), bodyEncoding: 'text', bodyTruncated: text.length > MAX_TEXT_BODY, size: buf.length };
    }
    if (isImage(mime) && buf.length <= MAX_IMAGE_BODY) {
      return { body: buf.toString('base64'), bodyEncoding: 'base64', size: buf.length };
    }
    return { body: null, bodyEncoding: 'omitted', size: buf.length };
  } catch (err) {
    return { body: null, bodyEncoding: 'unavailable', bodyError: String(err.message || err).split('\n')[0] };
  }
}

// ---------------- Playwright hooks ----------------
function onRequest(req) {
  const id = ++seq;
  reqIds.set(req, id);
  const e = {
    id, kind: 'http', state: 'pending',
    method: req.method(), url: req.url(), type: req.resourceType(),
    startedAt: now(),
    requestHeaders: req.headers(),
    postData: req.postData(),
    redirectedFrom: req.redirectedFrom() ? reqIds.get(req.redirectedFrom()) : undefined,
    isNavigation: req.isNavigationRequest(),
  };
  entries.set(id, e);
  pushEntry(e);
}

async function onRequestFinished(req) {
  const e = entries.get(reqIds.get(req));
  if (!e) return;
  try {
    const res = await req.response();
    e.requestHeaders = await req.allHeaders().catch(() => e.requestHeaders);
    e.requestHeadersArray = await req.headersArray().catch(() => undefined);
    if (res) {
      e.status = res.status();
      e.statusText = res.statusText();
      e.responseHeaders = await res.allHeaders().catch(() => res.headers());
      e.responseHeadersArray = await res.headersArray().catch(() => undefined);
      e.mimeType = (e.responseHeaders['content-type'] || '').split(';')[0].trim();
      e.remoteAddress = await res.serverAddr().catch(() => null);
      e.security = await res.securityDetails().catch(() => null);
      e.fromServiceWorker = res.fromServiceWorker();
      Object.assign(e, await readBody(res, e.mimeType));
    }
    const sizes = await req.sizes().catch(() => null);
    if (sizes) { e.sizes = sizes; if (e.size == null) e.size = sizes.responseBodySize; }
  } catch (err) {
    e.error = String(err.message || err).split('\n')[0];
  }
  e.timing = req.timing();
  e.duration = now() - e.startedAt;
  e.state = 'done';
  pushEntry(e);
}

async function onRequestFailed(req) {
  const e = entries.get(reqIds.get(req));
  if (!e) return;
  e.requestHeaders = await req.allHeaders().catch(() => e.requestHeaders);
  e.state = 'failed';
  e.error = req.failure()?.errorText || 'failed';
  e.timing = req.timing();
  e.duration = now() - e.startedAt;
  const res = await req.response().catch(() => null);
  if (res) { e.status = res.status(); e.statusText = res.statusText(); e.responseHeaders = await res.allHeaders().catch(() => res.headers()); }
  pushEntry(e);
}

// Handshake WebSocket lấy qua CDP (Playwright không expose header handshake).
// Ghép với entry WS theo URL: bên nào tới trước thì chờ bên kia.
const wsWaitingHandshake = new Map(); // url -> [entry]
const handshakeWaitingWs = new Map(); // url -> [handshake]
const handshakes = new Map(); // cdp requestId -> handshake
const takeFirst = (map, url) => { const q = map.get(url); const v = q && q.shift(); if (q && !q.length) map.delete(url); return v; };
const enqueue = (map, url, v) => { if (!map.has(url)) map.set(url, []); map.get(url).push(v); };

const hsEntry = new WeakMap(); // handshake -> entry (tránh vòng tham chiếu khi JSON.stringify)
const hsQueued = new WeakSet();

function attachHandshake(e, hs) {
  e.handshake = hs;
  hsEntry.set(hs, e);
  pushEntry(e);
}
function onHandshakeUpdate(hs) {
  if (hsEntry.has(hs)) return pushEntry(hsEntry.get(hs));
  const e = takeFirst(wsWaitingHandshake, hs.url);
  if (e) attachHandshake(e, hs); else if (!hsQueued.has(hs)) { hsQueued.add(hs); enqueue(handshakeWaitingWs, hs.url, hs); }
}
function resetWsQueues() { wsWaitingHandshake.clear(); handshakeWaitingWs.clear(); handshakes.clear(); }

async function hookCdp(context, page) {
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketCreated', ({ requestId, url }) => {
      const hs = { url, requestId };
      handshakes.set(requestId, hs);
      onHandshakeUpdate(hs);
    });
    cdp.on('Network.webSocketWillSendHandshakeRequest', ({ requestId, request }) => {
      const hs = handshakes.get(requestId); if (!hs) return;
      hs.requestHeaders = request.headers;
      onHandshakeUpdate(hs);
    });
    cdp.on('Network.webSocketHandshakeResponseReceived', ({ requestId, response }) => {
      const hs = handshakes.get(requestId); if (!hs) return;
      hs.status = response.status;
      hs.statusText = response.statusText;
      hs.responseHeaders = response.headers;
      // requestHeaders ở đây là header thật đã gửi (có Cookie), nếu Chrome cung cấp
      if (response.requestHeaders) hs.requestHeaders = response.requestHeaders;
      if (response.requestHeadersText) hs.requestHeadersText = response.requestHeadersText;
      if (response.headersText) hs.responseHeadersText = response.headersText;
      onHandshakeUpdate(hs);
    });
    cdp.on('Network.webSocketFrameError', ({ requestId, errorMessage }) => {
      const hs = handshakes.get(requestId); if (!hs) return;
      hs.frameError = errorMessage;
      onHandshakeUpdate(hs);
    });
  } catch (err) {
    console.log('CDP không khả dụng:', String(err.message || err).split('\n')[0]);
  }
}

function onWebSocket(ws) {
  const id = ++seq;
  const e = { id, kind: 'ws', type: 'websocket', method: 'WS', url: ws.url(), state: 'open', startedAt: now(), frames: [] };
  entries.set(id, e);
  pushEntry(e);
  const hs = takeFirst(handshakeWaitingWs, e.url);
  if (hs) attachHandshake(e, hs); else enqueue(wsWaitingHandshake, e.url, e);
  const addFrame = (dir, payload) => {
    const isBin = typeof payload !== 'string';
    let data = isBin ? payload.toString('base64') : payload;
    const truncated = data.length > MAX_WS_FRAME;
    if (truncated) data = data.slice(0, MAX_WS_FRAME);
    e.frames.push({ dir, time: now(), data, binary: isBin, length: payload.length, truncated });
    if (e.frames.length > MAX_WS_FRAMES) e.frames.shift();
    pushEntry(e);
  };
  ws.on('framesent', (f) => addFrame('sent', f.payload));
  ws.on('framereceived', (f) => addFrame('recv', f.payload));
  ws.on('socketerror', (err) => { e.state = 'error'; e.error = String(err); pushEntry(e); });
  ws.on('close', () => { if (e.state !== 'error') e.state = 'closed'; e.duration = now() - e.startedAt; pushEntry(e); });
}

// ---------------- Browser control ----------------
async function launchBrowser() {
  const opts = {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  // 1) Chromium của Playwright, 2) Edge (có sẵn trên Windows), 3) Chrome
  const attempts = [];
  try { if (fs.existsSync(chromium.executablePath())) attempts.push({}); } catch {}
  attempts.push({ channel: 'msedge' }, { channel: 'chrome' });
  let lastErr;
  for (const a of attempts) {
    try { return await chromium.launch({ ...opts, ...a }); } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

async function startSession(url) {
  await stopSession();
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: null });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    const noop = () => {};
    for (const m of ['log', 'debug', 'info', 'warn', 'error', 'table', 'dir', 'dirxml', 'trace', 'clear']) {
      try { console[m] = noop; } catch {}
    }
    try {
      Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
      Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 80 });
    } catch {}
  });
  context.on('request', onRequest);
  context.on('requestfinished', onRequestFinished);
  context.on('requestfailed', onRequestFailed);
  const cdpReady = new WeakMap();
  context.on('page', (p) => { p.on('websocket', onWebSocket); cdpReady.set(p, hookCdp(context, p)); });

  const thisBrowser = browser;
  browser.on('disconnected', () => {
    if (browser === thisBrowser) { browser = null; session = null; broadcast('status', status()); }
  });

  session = { url, startedAt: now() };
  broadcast('status', status());
  const page = await context.newPage();
  await cdpReady.get(page); // bật CDP Network trước khi tải trang để không lỡ handshake WebSocket
  page.goto(url, { waitUntil: 'commit' }).catch((err) => broadcast('notice', { level: 'error', text: `Không mở được ${url}: ${String(err.message).split('\n')[0]}` }));
}

async function stopSession() {
  const b = browser;
  browser = null; session = null;
  if (b) await b.close().catch(() => {});
  broadcast('status', status());
}

const status = () => ({ running: !!browser, url: session?.url || null, startedAt: session?.startedAt || null, count: entries.size });

// ---------------- HTTP server ----------------
function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(UI_HTML);
    }
    if (req.method === 'GET' && (u.pathname === '/icon.svg' || u.pathname === '/favicon.ico')) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
      return res.end(ICON_SVG);
    }
    if (req.method === 'GET' && u.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`);
      res.write(`event: snapshot\ndata: ${JSON.stringify([...entries.values()].map(summary))}\n\n`);
      clients.add(res);
      const ka = setInterval(() => res.write(': ka\n\n'), 15000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }
    if (req.method === 'GET' && u.pathname.startsWith('/api/entry/')) {
      const e = entries.get(Number(u.pathname.split('/').pop()));
      return e ? sendJson(res, 200, e) : sendJson(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && u.pathname === '/api/entries') {
      const { ids } = await readJson(req);
      const list = Array.isArray(ids) ? ids.map((id) => entries.get(id)).filter(Boolean) : [...entries.values()];
      return sendJson(res, 200, list);
    }
    if (req.method === 'POST' && u.pathname === '/api/start') {
      const { url } = await readJson(req);
      if (!/^https?:\/\/[^\s]+$/i.test(url || '')) return sendJson(res, 400, { error: 'URL phải bắt đầu bằng http:// hoặc https://' });
      try { await startSession(url); return sendJson(res, 200, status()); }
      catch (err) { return sendJson(res, 500, { error: String(err.message || err).split('\n')[0] }); }
    }
    if (req.method === 'POST' && u.pathname === '/api/stop') { await stopSession(); return sendJson(res, 200, status()); }
    if (req.method === 'POST' && u.pathname === '/api/clear') {
      entries.clear(); resetWsQueues(); broadcast('cleared', {}); return sendJson(res, 200, status());
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

function listen(port) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') { console.log(`Port ${port} bận, thử port khác...`); listen(0); }
    else throw err;
  });
  server.listen(port, '127.0.0.1', () => {
    const addr = `http://127.0.0.1:${server.address().port}`;
    console.log('==============================================');
    console.log(`  Network Tracer UI: ${addr}`);
    console.log('  Đóng cửa sổ này (hoặc Ctrl+C) để thoát.');
    console.log('==============================================');
    if (!process.env.NO_OPEN) exec(`cmd /c start "" "${addr}"`);
  });
}

async function shutdown() { await stopSession(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

listen(PORT);
