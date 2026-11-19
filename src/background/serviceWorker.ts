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
  statusDetail: 'Open Prime Video and press play',
  candidates: [],
  selectedId: null,
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

async function proxyApiGet(path: string): Promise<{
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
}> {
  const base = await resolveApiBase();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${base}${normalizedPath}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

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

function broadcastState(state: SidePanelState): void {
  latestState = withPanelFlag(state);
  void chrome.runtime.sendMessage({ type: 'SCF_STATE', state: latestState }).catch(() => {
    // receivers may be closed
  });

  // Notify content scripts about panel open/close so the status dot can toggle
  if (activeTabId != null) {
    void chrome.tabs
      .sendMessage(activeTabId, {
        type: 'SCF_PANEL_VISIBILITY',
        sidePanelOpen: latestState.sidePanelOpen,
        state: latestState,
      })
      .catch(() => {
        // tab may not have content script
      });
  }
}

function setSidePanelOpen(open: boolean): void {
  const next = withPanelFlag({
    ...latestState,
    sidePanelOpen: open,
  });
  broadcastState(next);
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

  if (message?.type === 'API_GET' && typeof message.path === 'string') {
    void proxyApiGet(message.path).then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === 'SCF_GET_STATE') {
    sendResponse({ state: withPanelFlag(latestState) });
    return false;
  }

  if (message?.type === 'SCF_STATE_UPDATE' && message.state) {
    if (sender.tab?.id != null) {
      activeTabId = sender.tab.id;
    }
    broadcastState(message.state as SidePanelState);
    sendResponse({ ok: true, sidePanelOpen: sidePanelPorts > 0 });
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

  if (message?.type === 'SCF_SELECT_TITLE' && typeof message.titleId === 'string') {
    const titleId = message.titleId;

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
        await chrome.tabs.sendMessage(tabId, {
          type: 'SCF_SELECT_TITLE',
          titleId,
        });
        return { ok: true };
      } catch (err) {
        logger.error('Failed to deliver selection to tab', err);
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
