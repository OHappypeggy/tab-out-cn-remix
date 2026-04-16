/**
 * background.js — Service Worker for badge updates and lightweight usage tracking
 *
 * Two jobs live here:
 * 1. Keep the toolbar badge showing the current open tab count.
 * 2. Track "active browser time" for the companion reminder in the new tab page.
 *
 * Usage tracking deliberately does NOT inspect browsing history. Instead it records
 * time only when:
 * - a Chrome window is focused, and
 * - the device is not idle / locked
 *
 * That gives us a practical "time spent actively using the browser today" signal
 * without reaching for more invasive history-based behavior.
 */

'use strict';

const USAGE_TOTALS_KEY = 'browserUsageDailyMs';
const USAGE_STATE_KEY = 'browserUsageTrackerState';
const USAGE_IDLE_INTERVAL_SECONDS = 120;
const USAGE_HEARTBEAT_ALARM = 'browser-usage-heartbeat';
const USAGE_HEARTBEAT_MINUTES = 1;
const USAGE_RETENTION_DAYS = 14;

let usageQueue = Promise.resolve();

function queueUsageTask(task) {
  usageQueue = usageQueue
    .catch(() => {})
    .then(task)
    .catch((err) => {
      console.warn('[tab-out] Usage tracking task failed:', err);
    });

  return usageQueue;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function getLocalDayKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function getNextDayStart(timestamp = Date.now()) {
  const date = new Date(timestamp);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

function cloneDailyTotals(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
}

function normalizeUsageState(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};

  return {
    hasFocusedWindow: Boolean(state.hasFocusedWindow),
    idleState: state.idleState === 'idle' || state.idleState === 'locked' ? state.idleState : 'active',
    activeSessionStartMs: Number.isFinite(state.activeSessionStartMs) ? state.activeSessionStartMs : null,
    lastSyncedAt: Number.isFinite(state.lastSyncedAt) ? state.lastSyncedAt : 0,
  };
}

function pruneDailyTotals(totals, now = Date.now()) {
  const allowedKeys = new Set();

  for (let offset = 0; offset < USAGE_RETENTION_DAYS; offset += 1) {
    allowedKeys.add(getLocalDayKey(now - offset * 24 * 60 * 60 * 1000));
  }

  return Object.fromEntries(
    Object.entries(totals).filter(([key, value]) => allowedKeys.has(key) && Number.isFinite(value) && value > 0)
  );
}

function addDurationToTotals(totals, startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;

  let cursor = startMs;

  while (cursor < endMs) {
    const segmentEnd = Math.min(getNextDayStart(cursor), endMs);
    const dayKey = getLocalDayKey(cursor);
    totals[dayKey] = (totals[dayKey] || 0) + (segmentEnd - cursor);
    cursor = segmentEnd;
  }
}

function shouldTrackUsage(state) {
  return Boolean(state.hasFocusedWindow) && state.idleState === 'active';
}

async function readUsageTracking() {
  const data = await chrome.storage.local.get([USAGE_TOTALS_KEY, USAGE_STATE_KEY]);
  return {
    totals: cloneDailyTotals(data[USAGE_TOTALS_KEY]),
    state: normalizeUsageState(data[USAGE_STATE_KEY]),
  };
}

async function writeUsageTracking(totals, state, now = Date.now()) {
  await chrome.storage.local.set({
    [USAGE_TOTALS_KEY]: pruneDailyTotals(totals, now),
    [USAGE_STATE_KEY]: state,
  });
}

async function updateUsageTracking(partialState = {}, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const { totals, state } = await readUsageTracking();

  if (options.resetSession) {
    state.activeSessionStartMs = null;
  }

  Object.assign(state, partialState);

  if (Number.isFinite(state.activeSessionStartMs)) {
    addDurationToTotals(totals, state.activeSessionStartMs, now);
    state.activeSessionStartMs = null;
  }

  if (shouldTrackUsage(state)) {
    state.activeSessionStartMs = now;
  }

  state.lastSyncedAt = now;
  await writeUsageTracking(totals, state, now);
}

async function getFocusedWindowState() {
  try {
    const windows = await chrome.windows.getAll({ populate: false });
    return windows.some((windowInfo) => Boolean(windowInfo.focused));
  } catch {
    return false;
  }
}

async function getIdleState() {
  try {
    return await chrome.idle.queryState(USAGE_IDLE_INTERVAL_SECONDS);
  } catch {
    return 'active';
  }
}

async function refreshUsageTracking(options = {}) {
  const [hasFocusedWindow, idleState] = await Promise.all([
    getFocusedWindowState(),
    getIdleState(),
  ]);

  await updateUsageTracking({ hasFocusedWindow, idleState }, options);
}

function ensureUsageTrackingSetup() {
  try {
    chrome.idle.setDetectionInterval(USAGE_IDLE_INTERVAL_SECONDS);
  } catch {
    // Ignore older / restricted environments and fall back to the default interval.
  }

  chrome.alarms.create(USAGE_HEARTBEAT_ALARM, { periodInMinutes: USAGE_HEARTBEAT_MINUTES });
}


// ─── Badge updater ────────────────────────────────────────────────────────────

async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    const count = tabs.filter((tab) => {
      const url = tab.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    let color;
    if (count <= 10) {
      color = '#3d7a4a';
    } else if (count <= 20) {
      color = '#b8892e';
    } else {
      color = '#b35a5a';
    }

    await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    chrome.action.setBadgeText({ text: '' });
  }
}


// ─── Event listeners ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  ensureUsageTrackingSetup();
  updateBadge();
  queueUsageTask(() => refreshUsageTracking({ resetSession: true }));
});

chrome.runtime.onStartup.addListener(() => {
  ensureUsageTrackingSetup();
  updateBadge();
  queueUsageTask(() => refreshUsageTracking({ resetSession: true }));
});

chrome.tabs.onCreated.addListener(() => {
  updateBadge();
});

chrome.tabs.onRemoved.addListener(() => {
  updateBadge();
});

chrome.tabs.onUpdated.addListener(() => {
  updateBadge();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  const hasFocusedWindow = windowId !== chrome.windows.WINDOW_ID_NONE;
  queueUsageTask(() => updateUsageTracking({ hasFocusedWindow }));
});

chrome.idle.onStateChanged.addListener((idleState) => {
  queueUsageTask(() => updateUsageTracking({ idleState }));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== USAGE_HEARTBEAT_ALARM) return;
  queueUsageTask(() => updateUsageTracking());
});


// ─── Initial run ─────────────────────────────────────────────────────────────

ensureUsageTrackingSetup();
updateBadge();
queueUsageTask(() => refreshUsageTracking());
