/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];
let bookmarks = [];
let bookmarkStandaloneParentId = null;
let bookmarkDragState = null;
let currentWallpaperMeta = null;
let wallpaperControlsBusy = false;
let usageCompanionTimer = null;
const SEARCH_HISTORY_KEY = 'searchHistory';
const MAX_SEARCH_HISTORY = 5;
const CUSTOM_WALLPAPER_KEY = 'customWallpaperDataUrl';
const CUSTOM_WALLPAPER_META_KEY = 'customWallpaperMeta';
const USAGE_TOTALS_KEY = 'browserUsageDailyMs';
const USAGE_STATE_KEY = 'browserUsageTrackerState';
const MAX_CUSTOM_WALLPAPER_FILE_BYTES = 15 * 1024 * 1024;
const MAX_CUSTOM_WALLPAPER_STORAGE_CHARS = 4_500_000;
const WALLPAPER_DIMENSION_STEPS = [2400, 2000, 1600, 1280];
const WALLPAPER_QUALITY_STEPS = [0.9, 0.82, 0.74, 0.66];
const USAGE_COMPANION_REFRESH_MS = 60 * 1000;

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   BOOKMARKS — chrome.bookmarks
   ---------------------------------------------------------------- */

function isBookmarkBarNode(node) {
  const title = (node?.title || '').toLowerCase();
  return node?.id === '1' || title === 'bookmark bar' || title === 'bookmarks bar';
}

async function fetchBookmarks() {
  if (!chrome.bookmarks?.getTree) {
    bookmarks = [];
    bookmarkStandaloneParentId = null;
    return;
  }

  try {
    const bookmarkTreeNodes = await chrome.bookmarks.getTree();
    if (!bookmarkTreeNodes || bookmarkTreeNodes.length === 0) {
      bookmarks = [];
      bookmarkStandaloneParentId = null;
      return;
    }

    const result = [];
    bookmarkStandaloneParentId = null;

    for (const root of bookmarkTreeNodes) {
      if (!root.children) continue;

      for (const child of root.children) {
        if (child.id === 'mobile___') continue;

        if (child.url) {
          result.push({
            id: child.id,
            parentId: child.parentId,
            index: child.index,
            url: child.url,
            title: child.title || 'Untitled',
            isBookmark: true,
          });
          continue;
        }

        if (!child.children || child.children.length === 0) continue;

        // Chrome usually stores "top-level" bookmark links inside the Bookmarks Bar
        // folder rather than as direct root children, so we surface those here.
        if (isBookmarkBarNode(child)) {
          bookmarkStandaloneParentId = child.id;

          for (const grandChild of child.children) {
            if (grandChild.url) {
              result.push({
                id: grandChild.id,
                parentId: grandChild.parentId,
                index: grandChild.index,
                url: grandChild.url,
                title: grandChild.title || 'Untitled',
                isBookmark: true,
              });
            } else if (grandChild.children && grandChild.children.length > 0) {
              const folder = processFolder(grandChild, 0);
              if (folder) result.push(folder);
            }
          }

          continue;
        }

        const folder = processFolder(child, 0);
        if (folder) result.push(folder);
      }
    }

    bookmarks = result;
  } catch (err) {
    console.error('Error fetching bookmarks:', err);
    bookmarks = [];
    bookmarkStandaloneParentId = null;
  }
}

function processFolder(node, depth) {
  if (!node || node.url) return null;

  const folder = {
    id: node.id,
    parentId: node.parentId,
    index: node.index,
    title: node.title || 'Untitled Folder',
    children: [],
    depth,
    isFolder: true,
  };

  if (!node.children) return folder;

  for (const child of node.children) {
    if (child.url) {
      folder.children.push({
        id: child.id,
        parentId: child.parentId,
        index: child.index,
        url: child.url,
        title: child.title || 'Untitled',
        isBookmark: true,
      });
    } else if (child.children && child.children.length > 0) {
      const subFolder = processFolder(child, depth + 1);
      if (subFolder) folder.children.push(subFolder);
    }
  }

  return folder;
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">标签页清空了。</div>
      <div class="empty-subtitle">现在清爽多了。</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 个分组';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return '刚刚';
  if (diffMins < 60)  return `${diffMins} 分钟前`;
  if (diffHours < 24) return `${diffHours} 小时前`;
  if (diffDays === 1) return '昨天';
  return `${diffDays} 天前`;
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return '早上好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('zh-CN', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function getLocalDayKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function getStartOfDay(timestamp = Date.now()) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function normalizeUsageTrackingState(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};

  return {
    hasFocusedWindow: Boolean(state.hasFocusedWindow),
    idleState: state.idleState === 'idle' || state.idleState === 'locked' ? state.idleState : 'active',
    activeSessionStartMs: Number.isFinite(state.activeSessionStartMs) ? state.activeSessionStartMs : null,
    lastSyncedAt: Number.isFinite(state.lastSyncedAt) ? state.lastSyncedAt : 0,
  };
}

function formatUsageDuration(durationMs) {
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0 && minutes <= 0) return '不到 1 分钟';
  if (hours <= 0) return `${minutes} 分钟`;
  if (minutes <= 0) return `${hours} 小时`;
  return `${hours} 小时 ${minutes} 分钟`;
}

function getActiveTodayOverlap(startMs, nowMs = Date.now()) {
  if (!Number.isFinite(startMs) || nowMs <= startMs) return 0;
  return Math.max(0, nowMs - Math.max(startMs, getStartOfDay(nowMs)));
}

function getUsageCompanionMessage(usageMs, now = new Date()) {
  const totalMinutes = Math.max(0, Math.floor(usageMs / 60000));
  const hour = now.getHours();

  if (totalMinutes < 5) {
    return '新的一天刚开场，慢慢进入状态就很好。';
  }

  if (hour >= 11 && hour < 14 && totalMinutes >= 120) {
    return '到午饭时间了，先去补充一点能量吧。';
  }

  if (hour >= 18 && hour < 21 && totalMinutes >= 300) {
    return '忙到现在已经很不容易了，晚饭和眼睛都别忘了照顾。';
  }

  if (totalMinutes >= 600) {
    return '今天已经和屏幕并肩作战 10 小时以上了，太拼了，也该休息一下啦。';
  }

  if (totalMinutes >= 480) {
    return '今天已经努力了很久，站起来伸个懒腰，肩膀会感谢你的。';
  }

  if (totalMinutes >= 300) {
    return '节奏很稳，喝口水，顺便让眼睛离开屏幕半分钟吧。';
  }

  if (hour < 12 && totalMinutes >= 60) {
    return '上午状态在线，继续稳稳推进。';
  }

  if (hour >= 14 && hour < 18 && totalMinutes >= 90) {
    return '下午也在稳定输出，记得眨眨眼，别把自己写成雕像。';
  }

  if (totalMinutes >= 30) {
    return `今天已经努力了 ${formatUsageDuration(usageMs)}，继续加油，也别忘了照顾自己。`;
  }

  return '热身已经开始了，今天也一起把节奏走顺。';
}

async function getUsageCompanionSnapshot() {
  try {
    const data = await chrome.storage.local.get([USAGE_TOTALS_KEY, USAGE_STATE_KEY]);
    const totals = data[USAGE_TOTALS_KEY] && typeof data[USAGE_TOTALS_KEY] === 'object'
      ? data[USAGE_TOTALS_KEY]
      : {};
    const trackingState = normalizeUsageTrackingState(data[USAGE_STATE_KEY]);
    const now = Date.now();
    const todayKey = getLocalDayKey(now);
    let usageMs = Number(totals[todayKey]) || 0;

    if (
      Number.isFinite(trackingState.activeSessionStartMs)
      && trackingState.hasFocusedWindow
      && trackingState.idleState === 'active'
    ) {
      usageMs += getActiveTodayOverlap(trackingState.activeSessionStartMs, now);
    }

    const hasStarted = usageMs > 0 || trackingState.lastSyncedAt > 0;

    return { usageMs, hasStarted };
  } catch {
    return { usageMs: 0, hasStarted: false };
  }
}

async function renderUsageCompanion() {
  const root = document.getElementById('usageCompanion');
  const timeEl = document.getElementById('usageCompanionTime');
  const messageEl = document.getElementById('usageCompanionMessage');

  if (!root || !timeEl || !messageEl) return;

  const { usageMs, hasStarted } = await getUsageCompanionSnapshot();

  if (!hasStarted) {
    timeEl.textContent = '刚开始记录';
    messageEl.textContent = '从这个版本开始，陪你记住今天和浏览器相处了多久。';
    root.title = '从当前版本开始记录今天的活跃浏览时长。';
    return;
  }

  const durationText = formatUsageDuration(usageMs);
  timeEl.textContent = `已陪你 ${durationText}`;
  messageEl.textContent = getUsageCompanionMessage(usageMs, new Date());
  root.title = '统计的是今天 Chrome 窗口处于焦点中且用户保持活跃时的使用时长。';
}

function startUsageCompanionTimer() {
  if (usageCompanionTimer) return;

  usageCompanionTimer = window.setInterval(() => {
    renderUsageCompanion();
  }, USAGE_COMPANION_REFRESH_MS);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getFaviconUrl(url, size = 32) {
  try {
    const hostname = new URL(url).hostname;
    return hostname ? `https://www.google.com/s2/favicons?domain=${hostname}&sz=${size}` : '';
  } catch {
    return '';
  }
}

function countBookmarksInTree(items) {
  return (items || []).reduce((total, item) => {
    if (item.isBookmark) return total + 1;
    if (item.isFolder) return total + countBookmarksInTree(item.children || []);
    return total;
  }, 0);
}

function countFoldersInTree(items) {
  return (items || []).reduce((total, item) => {
    if (!item.isFolder) return total;
    return total + 1 + countFoldersInTree(item.children || []);
  }, 0);
}

function isLikelyUrlInput(input) {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(input)
    || /^(localhost(:\d+)?|[\w-]+\.[\w.-]+)(\/.*)?$/i.test(input);
}

function resolveSearchTarget(query) {
  const trimmed = query.trim();
  if (!trimmed) return '';

  const looksLikeUrl = isLikelyUrlInput(trimmed);

  if (looksLikeUrl) {
    return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  }

  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

async function getSearchHistory() {
  try {
    const { [SEARCH_HISTORY_KEY]: history = [] } = await chrome.storage.local.get(SEARCH_HISTORY_KEY);
    return Array.isArray(history) ? history.slice(0, MAX_SEARCH_HISTORY) : [];
  } catch {
    return [];
  }
}

async function saveSearchHistory(query) {
  const trimmed = query.trim();
  if (!trimmed || isLikelyUrlInput(trimmed)) return;

  const history = await getSearchHistory();
  const nextHistory = [trimmed, ...history.filter(item => item !== trimmed)].slice(0, MAX_SEARCH_HISTORY);
  await chrome.storage.local.set({ [SEARCH_HISTORY_KEY]: nextHistory });
}

function setSearchHistoryVisibility(visible) {
  const dropdown = document.getElementById('searchHistoryDropdown');
  if (!dropdown) return;
  dropdown.style.display = visible ? 'block' : 'none';
}

function renderSearchHistoryDropdown(items) {
  const dropdown = document.getElementById('searchHistoryDropdown');
  if (!dropdown) return;

  if (!items || items.length === 0) {
    dropdown.innerHTML = '';
    setSearchHistoryVisibility(false);
    return;
  }

  dropdown.innerHTML = items.map(item => `
    <button
      type="button"
      class="search-history-item"
      data-action="use-search-history"
      data-query="${escapeHtml(item)}"
      title="${escapeHtml(item)}"
    >
      <span class="search-history-icon">${ICONS.history}</span>
      <span class="search-history-text">${escapeHtml(item)}</span>
    </button>
  `).join('');

  setSearchHistoryVisibility(true);
}

async function showSearchHistory(query = '') {
  const history = await getSearchHistory();
  const trimmed = query.trim().toLowerCase();
  const items = trimmed
    ? history.filter(item => item.toLowerCase().includes(trimmed)).slice(0, MAX_SEARCH_HISTORY)
    : history.slice(0, MAX_SEARCH_HISTORY);

  renderSearchHistoryDropdown(items);
}

async function runSearch(query) {
  const target = resolveSearchTarget(query);
  if (!target) return;

  await saveSearchHistory(query);

  try {
    const currentTab = await chrome.tabs.getCurrent();
    if (currentTab?.id) {
      await chrome.tabs.update(currentTab.id, { url: target });
      return;
    }
  } catch {
    // Fall back to a normal top-level navigation below.
  }

  window.location.assign(target);
}

function isValidWallpaperDataUrl(value) {
  return typeof value === 'string' && value.startsWith('data:image/');
}

function setWallpaperBackground(dataUrl = '') {
  if (!document.body) return;

  if (isValidWallpaperDataUrl(dataUrl)) {
    document.body.style.setProperty('--page-wallpaper', `url("${dataUrl}")`);
  } else {
    document.body.style.removeProperty('--page-wallpaper');
  }
}

function getWallpaperTriggerLabel(statusText = '') {
  if (statusText) return statusText;
  if (!currentWallpaperMeta) return '更换壁纸';

  const fileName = String(currentWallpaperMeta.name || '自定义壁纸').trim() || '自定义壁纸';
  return `更换壁纸（当前：${fileName}）`;
}

function renderWallpaperControls(statusText = '') {
  const uploadBtn = document.getElementById('wallpaperTrigger');
  const input = document.getElementById('wallpaperInput');

  if (uploadBtn) {
    const label = getWallpaperTriggerLabel(statusText);
    uploadBtn.disabled = wallpaperControlsBusy;
    uploadBtn.title = label;
    uploadBtn.setAttribute('aria-label', label);
  }

  if (input) input.disabled = wallpaperControlsBusy;
}

function setWallpaperBusy(isBusy, statusText = '') {
  wallpaperControlsBusy = isBusy;
  renderWallpaperControls(statusText);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error('invalid_wallpaper_data'));
    };

    reader.onerror = () => {
      reject(reader.error || new Error('wallpaper_read_failed'));
    };

    reader.readAsDataURL(file);
  });
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('wallpaper_decode_failed'));
    image.src = src;
  });
}

function renderWallpaperCandidate(image, maxDimension, quality) {
  const longestSide = Math.max(image.naturalWidth || 1, image.naturalHeight || 1);
  const scale = Math.min(1, maxDimension / longestSide);
  const width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  if (!context) throw new Error('wallpaper_canvas_failed');

  canvas.width = width;
  canvas.height = height;
  context.drawImage(image, 0, 0, width, height);

  return canvas.toDataURL('image/webp', quality);
}

async function createWallpaperDataUrl(file) {
  if (!file?.type?.startsWith('image/')) {
    throw new Error('wallpaper_invalid_type');
  }

  if (file.size > MAX_CUSTOM_WALLPAPER_FILE_BYTES) {
    throw new Error('wallpaper_file_too_large');
  }

  const sourceDataUrl = await readFileAsDataUrl(file);
  const image = await loadImageElement(sourceDataUrl);
  let smallestCandidate = '';

  for (const maxDimension of WALLPAPER_DIMENSION_STEPS) {
    for (const quality of WALLPAPER_QUALITY_STEPS) {
      const candidate = renderWallpaperCandidate(image, maxDimension, quality);

      if (!smallestCandidate || candidate.length < smallestCandidate.length) {
        smallestCandidate = candidate;
      }

      if (candidate.length <= MAX_CUSTOM_WALLPAPER_STORAGE_CHARS) {
        return candidate;
      }
    }
  }

  if (smallestCandidate && smallestCandidate.length <= MAX_CUSTOM_WALLPAPER_STORAGE_CHARS) {
    return smallestCandidate;
  }

  throw new Error('wallpaper_storage_too_large');
}

function getWallpaperErrorMessage(error) {
  switch (error?.message) {
    case 'wallpaper_invalid_type':
      return '请选择 JPG、PNG 或 WebP 图片';
    case 'wallpaper_file_too_large':
      return '图片太大了，请选择 15MB 内的图片';
    case 'wallpaper_storage_too_large':
      return '图片仍然过大，请换一张更小的图';
    default:
      return '壁纸保存失败';
  }
}

async function applyStoredWallpaper() {
  try {
    const {
      [CUSTOM_WALLPAPER_KEY]: storedWallpaper = '',
      [CUSTOM_WALLPAPER_META_KEY]: storedMeta = null,
    } = await chrome.storage.local.get([CUSTOM_WALLPAPER_KEY, CUSTOM_WALLPAPER_META_KEY]);

    if (isValidWallpaperDataUrl(storedWallpaper)) {
      currentWallpaperMeta = storedMeta && typeof storedMeta === 'object' ? storedMeta : { name: '自定义壁纸' };
      setWallpaperBackground(storedWallpaper);
    } else {
      currentWallpaperMeta = null;
      setWallpaperBackground('');
    }
  } catch {
    currentWallpaperMeta = null;
    setWallpaperBackground('');
  }

  renderWallpaperControls();
}

async function saveCustomWallpaper(file) {
  const dataUrl = await createWallpaperDataUrl(file);
  const meta = {
    name: file.name || '自定义壁纸',
    updatedAt: Date.now(),
  };

  await chrome.storage.local.set({
    [CUSTOM_WALLPAPER_KEY]: dataUrl,
    [CUSTOM_WALLPAPER_META_KEY]: meta,
  });

  currentWallpaperMeta = meta;
  setWallpaperBackground(dataUrl);
  renderWallpaperControls();
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `@${username} 的帖子` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube 视频';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} 帖子`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
  chevron: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" /></svg>`,
  folder:  `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 7.5A2.25 2.25 0 0 1 4.5 5.25h4.379c.597 0 1.17.237 1.591.659l1.122 1.122c.422.422.994.659 1.591.659H19.5A2.25 2.25 0 0 1 21.75 9.94v6.31A2.25 2.25 0 0 1 19.5 18.5h-15A2.25 2.25 0 0 1 2.25 16.25V7.5Z" /></svg>`,
  history: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6l4 2.25" /><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 12a8.25 8.25 0 1 0 2.42-5.83" /><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 4.5v4.5h4.5" /></svg>`,
  edit:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a2.25 2.25 0 1 1 3.182 3.182L10.582 17.13a4.5 4.5 0 0 1-1.897 1.13L6 19l.74-2.685a4.5 4.5 0 0 1 1.13-1.897L16.862 4.487Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 7.125 16.875 4.5" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="稍后处理">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="关闭这个标签页">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">再展开 ${hiddenTabs.length} 个</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    已打开 ${tabCount} 个
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge duplicate-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        重复 ${totalExtras} 个
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="稍后处理">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="关闭这个标签页">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      关闭这组 ${tabCount} 个标签页
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        关闭重复的 ${totalExtras} 个
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? '首页标签' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">标签页</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   BOOKMARKS — Render Nested Bookmarks
   ---------------------------------------------------------------- */

function renderBookmarkItem(bookmark, className) {
  const title = escapeHtml(bookmark.title || '未命名');
  const href = escapeHtml(bookmark.url || '#');
  const faviconUrl = getFaviconUrl(bookmark.url);
  const parentId = escapeHtml(bookmark.parentId || '');
  const index = Number.isInteger(bookmark.index) ? bookmark.index : '';
  const fallbackStyle = faviconUrl ? ' style="display:none"' : '';

  return `
    <div
      class="bookmark-node-shell ${className}"
      draggable="true"
      data-node-id="${bookmark.id}"
      data-node-parent-id="${parentId}"
      data-node-index="${index}"
      data-node-kind="bookmark"
      data-node-title="${title}"
    >
      <a
        class="bookmark-node-link"
        href="${href}"
        target="_top"
        rel="noopener"
        title="${title}"
      >
        ${faviconUrl ? `<img class="bookmark-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'">` : ''}
        <span class="bookmark-item-dot"${fallbackStyle}></span>
        <span class="bookmark-item-title">${title}</span>
      </a>
      <button
        type="button"
        class="bookmark-edit-btn"
        data-action="rename-bookmark-node"
        data-node-id="${bookmark.id}"
        data-node-kind="bookmark"
        data-node-title="${title}"
        title="编辑书签名称"
        aria-label="编辑书签名称"
      >
        ${ICONS.edit}
      </button>
    </div>`;
}

function renderSubFolder(folder, depth) {
  const allChildren = folder.children || [];
  const bookmarkChildren = allChildren.filter(child => child.isBookmark);
  const subFolders = allChildren.filter(child => child.isFolder);
  const bookmarkCount = countBookmarksInTree(allChildren);
  const safeTitle = escapeHtml(folder.title || '未命名文件夹');
  const parentId = escapeHtml(folder.parentId || '');
  const index = Number.isInteger(folder.index) ? folder.index : '';

  return `
    <div
      class="bookmark-subfolder-block"
      data-folder-id="${folder.id}"
      data-node-id="${folder.id}"
      data-node-parent-id="${parentId}"
      data-node-index="${index}"
      data-node-kind="folder"
      data-node-title="${safeTitle}"
      draggable="true"
      style="--folder-depth:${depth}"
    >
      <div class="bookmark-folder-toolbar">
        <button class="bookmark-subfolder-header" type="button" aria-expanded="true">
          <span class="bookmark-folder-caret">${ICONS.chevron}</span>
          <span class="bookmark-folder-glyph">${ICONS.folder}</span>
          <span class="bookmark-subfolder-name">${safeTitle}</span>
          <span class="bookmark-subfolder-count">${bookmarkCount}</span>
        </button>
        <button
          type="button"
          class="bookmark-edit-btn bookmark-folder-edit-btn"
          data-action="rename-bookmark-node"
          data-node-id="${folder.id}"
          data-node-kind="folder"
          data-node-title="${safeTitle}"
          title="编辑文件夹名称"
          aria-label="编辑文件夹名称"
        >
          ${ICONS.edit}
        </button>
      </div>
      <div class="bookmark-subfolder-items" data-drop-folder-id="${folder.id}">
        ${bookmarkChildren.map(child => renderBookmarkItem(child, 'bookmark-subfolder-item')).join('')}
      </div>
      ${subFolders.map(child => renderSubFolder(child, depth + 1)).join('')}
    </div>`;
}

function renderFolder(folder, depth) {
  const allChildren = folder.children || [];
  const bookmarkChildren = allChildren.filter(child => child.isBookmark);
  const subFolders = allChildren.filter(child => child.isFolder);
  const bookmarkCount = countBookmarksInTree(allChildren);
  const safeTitle = escapeHtml(folder.title || '未命名文件夹');
  const parentId = escapeHtml(folder.parentId || '');
  const index = Number.isInteger(folder.index) ? folder.index : '';

  return `
    <div
      class="bookmark-folder-block"
      data-folder-id="${folder.id}"
      data-node-id="${folder.id}"
      data-node-parent-id="${parentId}"
      data-node-index="${index}"
      data-node-kind="folder"
      data-node-title="${safeTitle}"
      draggable="true"
      style="--folder-depth:${depth}"
    >
      <div class="bookmark-folder-toolbar">
        <button class="bookmark-folder-header" type="button" aria-expanded="true">
          <span class="bookmark-folder-caret">${ICONS.chevron}</span>
          <span class="bookmark-folder-glyph">${ICONS.folder}</span>
          <span class="bookmark-folder-name">${safeTitle}</span>
          <span class="bookmark-folder-count">${bookmarkCount}</span>
        </button>
        <button
          type="button"
          class="bookmark-edit-btn bookmark-folder-edit-btn"
          data-action="rename-bookmark-node"
          data-node-id="${folder.id}"
          data-node-kind="folder"
          data-node-title="${safeTitle}"
          title="编辑文件夹名称"
          aria-label="编辑文件夹名称"
        >
          ${ICONS.edit}
        </button>
      </div>
      <div class="bookmark-folder-content">
        <div class="bookmark-folder-items" data-drop-folder-id="${folder.id}">
          ${bookmarkChildren.map(child => renderBookmarkItem(child, 'bookmark-folder-item')).join('')}
        </div>
        ${subFolders.map(child => renderSubFolder(child, depth + 1)).join('')}
      </div>
    </div>`;
}

async function renderBookmarksSection() {
  const section = document.getElementById('bookmarksSection');
  const bar = document.getElementById('bookmarksBar');
  const countEl = document.getElementById('bookmarksSectionCount');

  if (!section || !bar) return;

  if (bookmarks.length === 0) {
    section.style.display = 'none';
    bar.innerHTML = '';
    if (countEl) countEl.textContent = '';
    return;
  }

  section.style.display = 'block';

  const standaloneBookmarks = bookmarks.filter(item => item.isBookmark);
  const folders = bookmarks.filter(item => item.isFolder);
  const totalBookmarks = countBookmarksInTree(bookmarks);
  const totalFolders = countFoldersInTree(folders);

  let html = '';

  if (standaloneBookmarks.length > 0) {
    html += `
      <div class="bookmark-standalone-row" data-drop-folder-id="${bookmarkStandaloneParentId || ''}">
        ${standaloneBookmarks.map(bookmark => renderBookmarkItem(bookmark, 'bookmark-standalone-item')).join('')}
      </div>`;
  }

  for (const folder of folders) {
    html += renderFolder(folder, 0);
  }

  bar.innerHTML = html;

  if (countEl) {
    const folderText = totalFolders > 0 ? ` · ${totalFolders} 个文件夹` : '';
    countEl.textContent = `${totalBookmarks} 个书签${folderText}`;
  }

  addBookmarkDragEvents();
}

async function renameBookmarkNode(nodeId, currentTitle, kind) {
  const label = kind === 'folder' ? '文件夹' : '书签';
  const nextTitle = window.prompt(`修改${label}名称`, currentTitle || '');

  if (nextTitle == null) return false;

  const trimmed = nextTitle.trim();
  if (!trimmed || trimmed === currentTitle) return false;

  await chrome.bookmarks.update(nodeId, { title: trimmed });
  return true;
}

function getBookmarkDropInfo(target) {
  const bookmarkNode = target.closest('.bookmark-node-shell');
  if (bookmarkNode) {
    const parentId = bookmarkNode.dataset.nodeParentId;
    const index = Number.parseInt(bookmarkNode.dataset.nodeIndex || '', 10);
    return {
      highlightEl: bookmarkNode,
      parentId: parentId || null,
      index: Number.isNaN(index) ? null : index,
      beforeNodeId: bookmarkNode.dataset.nodeId || null,
    };
  }

  const dropContainer = target.closest('.bookmark-folder-items, .bookmark-subfolder-items, .bookmark-standalone-row');
  if (dropContainer) {
    return {
      highlightEl: dropContainer,
      parentId: dropContainer.dataset.dropFolderId || null,
      index: null,
      beforeNodeId: null,
    };
  }

  const folderNode = target.closest('.bookmark-folder-block, .bookmark-subfolder-block');
  if (folderNode) {
    const parentId = folderNode.dataset.nodeParentId;
    const index = Number.parseInt(folderNode.dataset.nodeIndex || '', 10);
    return {
      highlightEl: folderNode,
      parentId: parentId || null,
      index: Number.isNaN(index) ? null : index,
      beforeNodeId: folderNode.dataset.nodeId || null,
    };
  }

  return null;
}

function clearBookmarkDropTargets(bar) {
  bar.querySelectorAll('.bookmark-drop-target').forEach(el => {
    el.classList.remove('bookmark-drop-target');
  });
}

async function moveBookmarkNodeToTarget(dropInfo) {
  if (!bookmarkDragState?.id || !dropInfo?.parentId) return false;
  if (dropInfo.beforeNodeId === bookmarkDragState.id) return false;

  const moveDetails = { parentId: dropInfo.parentId };
  const movingWithinSameFolder = bookmarkDragState.parentId === dropInfo.parentId;
  let targetIndex = dropInfo.index;

  if (typeof targetIndex === 'number') {
    if (movingWithinSameFolder && bookmarkDragState.index < targetIndex) {
      targetIndex -= 1;
    }
  } else {
    const siblings = await chrome.bookmarks.getChildren(dropInfo.parentId);
    targetIndex = movingWithinSameFolder ? Math.max(0, siblings.length - 1) : siblings.length;
  }

  if (movingWithinSameFolder && targetIndex === bookmarkDragState.index) {
    return false;
  }

  moveDetails.index = Math.max(0, targetIndex);

  await chrome.bookmarks.move(bookmarkDragState.id, moveDetails);
  return true;
}

function addBookmarkDragEvents() {
  const bar = document.getElementById('bookmarksBar');
  if (!bar || bar.dataset.eventsBound === 'true') return;

  bar.dataset.eventsBound = 'true';

  bar.addEventListener('click', (e) => {
    const header = e.target.closest('.bookmark-folder-header');
    if (header) {
      const folderBlock = header.closest('.bookmark-folder-block');
      if (folderBlock) {
        folderBlock.classList.toggle('collapsed');
        header.setAttribute('aria-expanded', String(!folderBlock.classList.contains('collapsed')));
      }
      return;
    }

    const subHeader = e.target.closest('.bookmark-subfolder-header');
    if (subHeader) {
      const subFolderBlock = subHeader.closest('.bookmark-subfolder-block');
      if (subFolderBlock) {
        subFolderBlock.classList.toggle('collapsed');
        subHeader.setAttribute('aria-expanded', String(!subFolderBlock.classList.contains('collapsed')));
      }
    }
  });

  bar.addEventListener('dragstart', (e) => {
    const item = e.target.closest('[data-node-id]');
    if (!item) return;

    const index = Number.parseInt(item.dataset.nodeIndex || '', 10);
    bookmarkDragState = {
      id: item.dataset.nodeId,
      parentId: item.dataset.nodeParentId || null,
      index: Number.isNaN(index) ? null : index,
      kind: item.dataset.nodeKind || 'bookmark',
    };

    item.classList.add('dragging');

    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', bookmarkDragState.id || '');
    }
  });

  bar.addEventListener('dragover', (e) => {
    if (!bookmarkDragState) return;

    const dropInfo = getBookmarkDropInfo(e.target);
    if (!dropInfo?.parentId) return;

    e.preventDefault();
    clearBookmarkDropTargets(bar);
    dropInfo.highlightEl.classList.add('bookmark-drop-target');

    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  });

  bar.addEventListener('dragleave', (e) => {
    if (!bookmarkDragState) return;
    if (e.relatedTarget && bar.contains(e.relatedTarget)) return;
    clearBookmarkDropTargets(bar);
  });

  bar.addEventListener('dragend', (e) => {
    const item = e.target.closest('[data-node-id]');
    if (item) item.classList.remove('dragging');
    clearBookmarkDropTargets(bar);
    bookmarkDragState = null;
  });

  bar.addEventListener('drop', async (e) => {
    if (!bookmarkDragState) return;

    const dropInfo = getBookmarkDropInfo(e.target);
    clearBookmarkDropTargets(bar);

    if (!dropInfo?.parentId) {
      bookmarkDragState = null;
      return;
    }

    e.preventDefault();

    try {
      const moved = await moveBookmarkNodeToTarget(dropInfo);
      if (moved) {
        await fetchBookmarks();
        await renderBookmarksSection();
        showToast('已调整书签顺序');
      }
    } catch (err) {
      console.error('[tab-out] Could not move bookmark:', err);
      showToast('移动书签失败');
    } finally {
      bookmarkDragState = null;
    }
  });
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} 条`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="移除">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();
  await renderUsageCompanion();

  // --- Fetch bookmarks ---
  await fetchBookmarks();
  await renderBookmarksSection();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = '当前打开';
    openTabsSectionCount.innerHTML = `${domainGroups.length} 个分组 &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} 关闭全部 ${realTabs.length} 个标签页</button>`;
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) {
    if (!e.target.closest('#searchForm')) setSearchHistoryVisibility(false);
    return;
  }

  const action = actionEl.dataset.action;
  if (!actionEl.closest('#searchForm')) setSearchHistoryVisibility(false);

  if (action === 'use-search-history') {
    e.preventDefault();
    const query = actionEl.dataset.query || '';
    const input = document.getElementById('searchInput');
    if (input) input.value = query;
    setSearchHistoryVisibility(false);
    await runSearch(query);
    return;
  }

  if (action === 'open-wallpaper-picker') {
    e.preventDefault();
    const input = document.getElementById('wallpaperInput');
    if (!input || wallpaperControlsBusy) return;
    input.value = '';
    input.click();
    return;
  }

  if (action === 'rename-bookmark-node') {
    e.preventDefault();
    e.stopPropagation();

    const nodeId = actionEl.dataset.nodeId;
    const currentTitle = actionEl.dataset.nodeTitle || '';
    const kind = actionEl.dataset.nodeKind || 'bookmark';
    if (!nodeId) return;

    try {
      const renamed = await renameBookmarkNode(nodeId, currentTitle, kind);
      if (renamed) {
        await fetchBookmarks();
        await renderBookmarksSection();
        showToast(kind === 'folder' ? '已更新文件夹名称' : '已更新书签名称');
      }
    } catch (err) {
      console.error('[tab-out] Could not rename bookmark node:', err);
      showToast(kind === 'folder' ? '修改文件夹名称失败' : '修改书签名称失败');
    }
    return;
  }

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('已关闭多余的 Tab Out 页面');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast('已关闭标签页');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('暂存失败');
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('已加入稍后处理');
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? '首页标签' : (group.label || friendlyDomain(group.domain));
    showToast(`已关闭 ${groupLabel} 中的 ${urls.length} 个标签页`);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.duplicate-badge').forEach(badge => {
        badge.style.transition = 'opacity 0.2s';
        badge.style.opacity    = '0';
        setTimeout(() => badge.remove(), 200);
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('已关闭重复标签页，并保留一份');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('已关闭所有标签页。重新开始吧。');
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

document.addEventListener('input', async (e) => {
  if (e.target.id === 'searchInput') {
    await showSearchHistory(e.target.value || '');
    return;
  }

  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">没有匹配结果</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.id !== 'wallpaperInput') return;

  const file = e.target.files?.[0];
  e.target.value = '';

  if (!file) return;

  try {
    setWallpaperBusy(true, '正在处理壁纸...');
    await saveCustomWallpaper(file);
    showToast('已更新首页壁纸');
  } catch (err) {
    console.error('[tab-out] Could not save wallpaper:', err);
    showToast(getWallpaperErrorMessage(err));
  } finally {
    setWallpaperBusy(false);
  }
});

document.addEventListener('focusin', async (e) => {
  if (e.target.id !== 'searchInput') return;
  await showSearchHistory(e.target.value || '');
});

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'searchForm') return;

  e.preventDefault();
  const input = document.getElementById('searchInput');
  const query = input?.value || '';

  setSearchHistoryVisibility(false);
  await runSearch(query);
});

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    if (CUSTOM_WALLPAPER_KEY in changes || CUSTOM_WALLPAPER_META_KEY in changes) {
      if (CUSTOM_WALLPAPER_KEY in changes) {
        const nextWallpaper = changes[CUSTOM_WALLPAPER_KEY]?.newValue;

        if (isValidWallpaperDataUrl(nextWallpaper)) {
          currentWallpaperMeta = CUSTOM_WALLPAPER_META_KEY in changes
            ? changes[CUSTOM_WALLPAPER_META_KEY]?.newValue || { name: '自定义壁纸' }
            : currentWallpaperMeta || { name: '自定义壁纸' };
          setWallpaperBackground(nextWallpaper);
        } else {
          currentWallpaperMeta = null;
          setWallpaperBackground('');
        }
      } else if (CUSTOM_WALLPAPER_META_KEY in changes && currentWallpaperMeta) {
        currentWallpaperMeta = changes[CUSTOM_WALLPAPER_META_KEY]?.newValue || currentWallpaperMeta;
      }

      if (!wallpaperControlsBusy) renderWallpaperControls();
    }

    if (USAGE_TOTALS_KEY in changes || USAGE_STATE_KEY in changes) {
      renderUsageCompanion();
    }
  });
}

if (chrome.bookmarks?.onCreated) {
  const rerenderBookmarks = async () => {
    await fetchBookmarks();
    await renderBookmarksSection();
  };

  chrome.bookmarks.onCreated.addListener(rerenderBookmarks);
  chrome.bookmarks.onRemoved.addListener(rerenderBookmarks);
  chrome.bookmarks.onChanged.addListener(rerenderBookmarks);
  chrome.bookmarks.onMoved.addListener(rerenderBookmarks);
}


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
async function initializeDashboard() {
  await applyStoredWallpaper();
  await renderDashboard();
  startUsageCompanionTimer();
}

initializeDashboard();
