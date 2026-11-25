import { logger } from '../utils/logger';
import type { SidePanelState } from '../types/panel';

const DEFAULT_API = 'http://localhost:3001/api';
const PANEL_PORT = 'scf-sidepanel';

declare const __SCF_API_BASE_URL__: string;

const BUILD_API_BASE =
  typeof __SCF_API_BASE_URL__ !== 'undefined'
    ? __SCF_API_BASE_URL__
    : DEFAULT_API;

let latestState: SidePanelState = {
  playerOpen: false,
  sidePanelOpen: false,
  status: 'initialized',
  statusDetail: 'Open a movie or show on Prime Video',
  detected: null,
  selectedEpisode: null,
  updatedAt: Date.now(),
};

/** tabId that last reported SCF state (Prime player tab) */
let activeTabId: number | null = null;
let sidePanelPorts = 0;

async function resolveApiBase(): Promise<string> {
  try {
    const stored = await chrome.storage.sync.get(['apiBaseUrl']);
    if (typeof stored.apiBaseUrl === 'string' && stored.apiBaseUrl.trim()) {
      return stored.apiBaseUrl.replace(/\/$/, '');
    }
  } catch {
    // ignore
  }
  return BUILD_API_BASE.replace(/\/$/, '');
}

async function proxyApi(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<{
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
}> {
  const base = await resolveApiBase();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${base}${normalizedPath}`;
  const method = (options.method || 'GET').toUpperCase();

  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const init: RequestInit = { method, headers };

    if (options.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, init);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    return { ok: response.ok, status: response.status, body };
  } catch (err) {
    logger.error('Proxy fetch failed', url, err);
    return {
      ok: false,
      status: 0,
      body: null,
      error: err instanceof Error ? err.message : 'Fetch failed',
    };
  }
}

function withPanelFlag(state: SidePanelState): SidePanelState {
  return {
    ...state,
    sidePanelOpen: sidePanelPorts > 0,
    updatedAt: Date.now(),
  };
}

let lastNotifiedPanelOpen: boolean | null = null;

function broadcastState(state: SidePanelState): void {
  latestState = withPanelFlag(state);
  if (sidePanelPorts === 0) return;
  void chrome.runtime.sendMessage({ type: 'SCF_STATE', state: latestState }).catch(() => {
    // receivers may be closed
  });
}

function notifyTabPanelVisibility(open: boolean): void {
  if (activeTabId == null || lastNotifiedPanelOpen === open) return;
  lastNotifiedPanelOpen = open;
  void chrome.tabs
    .sendMessage(activeTabId, { type: 'SCF_PANEL_VISIBILITY', sidePanelOpen: open })
    .catch(() => {
      // tab may not have content script
    });
}

function setSidePanelOpen(open: boolean): void {
  latestState = withPanelFlag({ ...latestState, sidePanelOpen: open });
  if (open) {
    void chrome.runtime
      .sendMessage({ type: 'SCF_STATE', state: latestState })
      .catch(() => {});
  }
  notifyTabPanelVisibility(open);
  logger.info('Side panel visibility', { open, ports: sidePanelPorts });
}

chrome.runtime.onInstalled.addListener((details) => {
  logger.info('Extension installed', details.reason);

  chrome.storage.sync.get(['apiBaseUrl'], (result) => {
    if (!result.apiBaseUrl) {
      chrome.storage.sync.set({ apiBaseUrl: BUILD_API_BASE });
    }
  });

  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => logger.warn('sidePanel behavior failed', err));
});

void chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => logger.warn('sidePanel behavior failed', err));

function resetStateForNavigation(detail: string): void {
  broadcastState({
    playerOpen: false,
    sidePanelOpen: sidePanelPorts > 0,
    status: 'initialized',
    statusDetail: detail,
    detected: null,
    selectedEpisode: null,
    selectedGti: null,
    currentTime: null,
    updatedAt: Date.now(),
  });
}

function detailPageKey(url: string): string {
  const match = url.match(/\/detail\/([A-Za-z0-9]+)/i);
  return match ? match[1].toLowerCase() : url.split('?')[0];
}

// Drop the cached title whenever the Prime tab moves to a different page, so the
// panel never shows a stale title (e.g. after the content script was invalidated).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== activeTabId || !changeInfo.url) return;
  const previous = latestState.detected?.pageUrl;
  if (previous && detailPageKey(previous) === detailPageKey(changeInfo.url)) return;
  resetStateForNavigation(
    tab.url && /primevideo\.com|amazon\.com/.test(tab.url)
      ? 'Navigated — detecting title…'
      : 'Open a movie or show on Prime Video'
  );
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== activeTabId) return;
  activeTabId = null;
  resetStateForNavigation('Open a movie or show on Prime Video');
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT) return;

  sidePanelPorts += 1;
  setSidePanelOpen(true);
  port.postMessage({ type: 'SCF_STATE', state: latestState });

  port.onDisconnect.addListener(() => {
    sidePanelPorts = Math.max(0, sidePanelPorts - 1);
    setSidePanelOpen(sidePanelPorts > 0);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'GET_API_BASE') {
    void resolveApiBase().then((apiBaseUrl) => {
      sendResponse({ apiBaseUrl });
    });
    return true;
  }

  if (message?.type === 'SET_API_BASE' && typeof message.apiBaseUrl === 'string') {
    chrome.storage.sync.set({ apiBaseUrl: message.apiBaseUrl }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (
    (message?.type === 'API_GET' ||
      message?.type === 'API_POST' ||
      message?.type === 'API_PUT') &&
    typeof message.path === 'string'
  ) {
    const method =
      message.type === 'API_POST'
        ? 'POST'
        : message.type === 'API_PUT'
          ? 'PUT'
          : 'GET';
    void proxyApi(message.path, { method, body: message.body }).then((result) =>
      sendResponse(result)
    );
    return true;
  }

  if (message?.type === 'SCF_GET_PLAYBACK_TIME') {
    const deliver = async () => {
      let tabId = activeTabId;
      if (tabId == null) {
        const tabs = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        tabId = tabs[0]?.id ?? null;
      }
      if (tabId == null) {
        return { ok: false, error: 'No active Prime Video tab' };
      }
      try {
        return (await chrome.tabs.sendMessage(tabId, {
          type: 'SCF_GET_PLAYBACK_TIME',
        })) as { ok: boolean; currentTime?: number; error?: string };
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Prime Video tab unavailable. Refresh the page.',
        };
      }
    };
    void deliver().then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === 'SCF_GET_STATE') {
    sendResponse({ state: withPanelFlag(latestState) });
    return false;
  }

  if (message?.type === 'SCF_STATE_UPDATE' && message.state) {
    if (sender.tab?.id != null && sender.tab.id !== activeTabId) {
      activeTabId = sender.tab.id;
      lastNotifiedPanelOpen = null;
    }
    broadcastState(message.state as SidePanelState);
    sendResponse({ ok: true, sidePanelOpen: sidePanelPorts > 0 });
    return false;
  }

  if (message?.type === 'SCF_TIME_UPDATE') {
    latestState = {
      ...latestState,
      playerOpen: Boolean(message.playerOpen),
      currentTime:
        typeof message.currentTime === 'number' ? message.currentTime : null,
      adPlaying: Boolean(message.adPlaying),
    };
    if (sidePanelPorts > 0) {
      void chrome.runtime
        .sendMessage({
          type: 'SCF_TIME',
          playerOpen: latestState.playerOpen,
          currentTime: latestState.currentTime,
          adPlaying: latestState.adPlaying,
        })
        .catch(() => {});
    }
    return false;
  }

  if (message?.type === 'SCF_OPEN_SIDE_PANEL') {
    const open = async () => {
      const tabId = sender.tab?.id ?? activeTabId;
      if (tabId == null) {
        return { ok: false, error: 'No tab to attach side panel' };
      }
      try {
        await chrome.sidePanel.open({ tabId });
        return { ok: true };
      } catch (err) {
        logger.error('Failed to open side panel', err);
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Could not open side panel',
        };
      }
    };
    void open().then((result) => sendResponse(result));
    return true;
  }

  if (
    (message?.type === 'SCF_SELECT_TITLE' && typeof message.titleId === 'string') ||
    (message?.type === 'SCF_SELECT_EPISODE' && typeof message.episodeName === 'string') ||
    message?.type === 'SCF_FILTERS_CHANGED'
  ) {
    const payload =
      message.type === 'SCF_SELECT_EPISODE'
        ? {
            type: 'SCF_SELECT_EPISODE',
            episodeName: message.episodeName,
            ...(typeof message.gti === 'string' ? { gti: message.gti } : {}),
          }
        : message.type === 'SCF_FILTERS_CHANGED'
          ? {
              type: 'SCF_FILTERS_CHANGED',
              ...(typeof message.gti === 'string' ? { gti: message.gti } : {}),
            }
          : { type: 'SCF_SELECT_TITLE', titleId: message.titleId };

    const deliver = async () => {
      let tabId = activeTabId;
      if (tabId == null) {
        const tabs = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        tabId = tabs[0]?.id ?? null;
      }
      if (tabId == null) {
        return { ok: false, error: 'No active Prime Video tab' };
      }

      try {
        await chrome.tabs.sendMessage(tabId, payload);
        return { ok: true };
      } catch (err) {
        logger.error('Failed to deliver message to tab', err);
        return {
          ok: false,
          error: 'Prime Video tab unavailable. Refresh the page.',
        };
      }
    };

    void deliver().then((result) => sendResponse(result));
    return true;
  }

  return false;
});

logger.info('SCF service worker loaded');
