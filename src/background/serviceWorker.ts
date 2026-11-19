import { logger } from '../utils/logger';

const DEFAULT_API = 'http://localhost:3001/api';

declare const __SCF_API_BASE_URL__: string;

const BUILD_API_BASE =
  typeof __SCF_API_BASE_URL__ !== 'undefined'
    ? __SCF_API_BASE_URL__
    : DEFAULT_API;

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

/**
 * Fetch from the backend inside the service worker so content scripts on
 * primevideo.com are not blocked by Chrome Private Network Access (loopback).
 */
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

chrome.runtime.onInstalled.addListener((details) => {
  logger.info('Extension installed', details.reason);

  chrome.storage.sync.get(['apiBaseUrl'], (result) => {
    if (!result.apiBaseUrl) {
      chrome.storage.sync.set({ apiBaseUrl: BUILD_API_BASE });
    }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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

  return false;
});

logger.info('SCF service worker loaded');
