import {
  ExtensionContextInvalidatedError,
  fetchAllTitleConfigs,
  isExtensionContextValid,
} from '../services/filterApi';
import {
  findSeriesCandidates,
  type SeriesMatchResult,
} from '../services/seriesMatch';
import type { ExtensionStatus, TitleFilterConfig } from '../types';
import type { SidePanelState } from '../types/panel';
import { logger } from '../utils/logger';
import { StatusDot } from '../utils/statusDot';
import { FilterManager } from './filterManager';
import { isPlayerOpen } from './playerGate';
import { VideoDetector } from './videoDetector';

const CONFIG_REFRESH_MS = 20_000;

const statusDot = new StatusDot();
const filterManager = new FilterManager((s, detail) => {
  if (!matchedConfig) return;
  if (s === 'filtering_active') {
    uiStatus = 'filtering_active';
    if (detail) uiDetail = detail;
    publishState();
  }
});

/** Remember which episode the user picked for a series during this page session */
const selectionBySeries = new Map<string, string>();

let titleConfigs: TitleFilterConfig[] = [];
let matchedConfig: TitleFilterConfig | null = null;
let activeSeries: SeriesMatchResult | null = null;
let uiStatus: ExtensionStatus = 'initialized';
let uiDetail = 'Waiting for player';
let lastHref = '';
let loadingFilters = false;
let lastConfigFetchAt = 0;
let detector: VideoDetector | null = null;
let pollTimer: number | null = null;
let contextInvalidated = false;
let lastPlayerOpen = false;
let sidePanelOpen = false;

function handleContextInvalidated(): void {
  if (contextInvalidated) return;
  contextInvalidated = true;

  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }

  uiStatus = 'backend_failed';
  uiDetail = 'Extension reloaded — refresh this tab';
  publishState();
  logger.warn(
    'Extension context invalidated. Refresh this Prime Video tab after reloading the extension.'
  );
}

function syncStatusDot(): void {
  const filtering = Boolean(matchedConfig) && uiStatus === 'filtering_active';
  statusDot.setStatus(uiStatus, filtering);
  // Dot only while side panel is closed
  statusDot.setVisible(!sidePanelOpen);
}

function publishState(detailOverride?: string): void {
  if (detailOverride) uiDetail = detailOverride;

  const state: SidePanelState = {
    playerOpen: isPlayerOpen(),
    sidePanelOpen,
    status: uiStatus,
    statusDetail: uiDetail,
    seriesLabel: activeSeries?.seriesLabel ?? null,
    seriesKey: activeSeries?.seriesKey ?? null,
    reasons: activeSeries?.reasons ?? [],
    candidates: (activeSeries?.candidates ?? []).map((c) => ({
      titleId: c.titleId,
      title: c.title,
      kind: c.kind,
      episodeName: c.episodeName,
      filterCount: c.filters.length,
      filters: c.filters,
    })),
    selectedId: matchedConfig?.titleId ?? null,
    updatedAt: Date.now(),
  };

  syncStatusDot();

  void chrome.runtime
    .sendMessage({ type: 'SCF_STATE_UPDATE', state })
    .then((response) => {
      if (response && typeof response.sidePanelOpen === 'boolean') {
        sidePanelOpen = response.sidePanelOpen;
        syncStatusDot();
      }
    })
    .catch(() => {
      // background may be restarting
    });
}

function openSidePanelFromDot(): void {
  void chrome.runtime.sendMessage({ type: 'SCF_OPEN_SIDE_PANEL' }).then((result) => {
    if (result?.ok) {
      sidePanelOpen = true;
      syncStatusDot();
    } else {
      logger.warn('Could not open side panel', result?.error);
    }
  });
}

async function ensureConfigsLoaded(force = false): Promise<boolean> {
  if (contextInvalidated || !isExtensionContextValid()) {
    handleContextInvalidated();
    return titleConfigs.length > 0;
  }

  const stale =
    force ||
    titleConfigs.length === 0 ||
    Date.now() - lastConfigFetchAt > CONFIG_REFRESH_MS;

  if (!stale) return true;
  if (loadingFilters) return titleConfigs.length > 0;

  loadingFilters = true;
  try {
    titleConfigs = await fetchAllTitleConfigs();
    lastConfigFetchAt = Date.now();
    logger.info('Loaded title configs', titleConfigs.length);
    return true;
  } catch (err) {
    if (err instanceof ExtensionContextInvalidatedError) {
      handleContextInvalidated();
      return titleConfigs.length > 0;
    }

    uiStatus = 'backend_failed';
    uiDetail = err instanceof Error ? err.message : 'API error';
    publishState();
    logger.error('Failed to load title configs', err);
    return titleConfigs.length > 0;
  } finally {
    loadingFilters = false;
  }
}

function clearMatch(reason: string): void {
  if (matchedConfig || activeSeries) {
    logger.info('Clearing title selection', {
      reason,
      previousTitleId: matchedConfig?.titleId ?? null,
    });
  }
  matchedConfig = null;
  activeSeries = null;
  filterManager.detachVideo();
}

function applySelectedConfig(config: TitleFilterConfig): void {
  const previousId = matchedConfig?.titleId;
  matchedConfig = config;
  filterManager.loadConfig(config);

  if (activeSeries) {
    selectionBySeries.set(activeSeries.seriesKey, config.titleId);
  }

  const video = detector?.getCurrent();
  if (video && isPlayerOpen()) {
    filterManager.detachVideo();
    filterManager.attachVideo(video);
  }

  uiStatus = 'filtering_active';
  uiDetail = config.episodeName
    ? `${config.title} · ${config.episodeName}`
    : config.title;
  publishState();

  logger.info('User selected filter config', {
    titleId: config.titleId,
    title: config.title,
    episodeName: config.episodeName,
    filterCount: config.filters.length,
    previousTitleId: previousId ?? null,
  });
}

function presentSeries(series: SeriesMatchResult): void {
  activeSeries = series;

  const rememberedId = selectionBySeries.get(series.seriesKey);
  const remembered = series.candidates.find((c) => c.titleId === rememberedId);

  if (series.candidates.length === 1 && series.candidates[0].kind !== 'show') {
    applySelectedConfig(series.candidates[0]);
    return;
  }

  if (remembered) {
    applySelectedConfig(remembered);
    return;
  }

  matchedConfig = null;
  filterManager.detachVideo();
  uiStatus = 'awaiting_selection';
  uiDetail = `${series.seriesLabel} · ${series.candidates.length} options`;
  publishState();

  logger.info('Series ready for side-panel selection', {
    seriesKey: series.seriesKey,
    seriesLabel: series.seriesLabel,
    reasons: series.reasons,
    options: series.candidates.map((c) => ({
      titleId: c.titleId,
      episodeName: c.episodeName,
      filters: c.filters.length,
    })),
  });
}

async function resolveSeriesForPlayer(forceRefresh = false): Promise<void> {
  if (!isPlayerOpen()) {
    uiStatus = 'initialized';
    uiDetail = 'Waiting for player';
    publishState();
    return;
  }

  const ok = await ensureConfigsLoaded(forceRefresh);
  if (!ok) return;

  const series = findSeriesCandidates(
    titleConfigs,
    location.href,
    document.title
  );

  if (!series || series.candidates.length === 0) {
    clearMatch('no series candidates');
    uiStatus = 'title_not_matched';
    uiDetail = 'No SCF titles matched this player';
    publishState();
    return;
  }

  if (
    activeSeries?.seriesKey === series.seriesKey &&
    matchedConfig &&
    series.candidates.some((c) => c.titleId === matchedConfig?.titleId)
  ) {
    activeSeries = series;
    const fresh = series.candidates.find(
      (c) => c.titleId === matchedConfig?.titleId
    );
    if (
      fresh &&
      JSON.stringify(fresh.filters) !== JSON.stringify(matchedConfig.filters)
    ) {
      applySelectedConfig(fresh);
      return;
    }
    publishState();
    return;
  }

  presentSeries(series);
}

async function onVideoChange(video: HTMLVideoElement | null): Promise<void> {
  if (!video || !isPlayerOpen()) {
    lastPlayerOpen = false;
    clearMatch('player closed or video gone');
    uiStatus = 'initialized';
    uiDetail = 'Waiting for player';
    publishState();
    return;
  }

  const openedJustNow = !lastPlayerOpen;
  lastPlayerOpen = true;
  uiStatus = matchedConfig ? 'filtering_active' : 'video_detected';
  uiDetail = describeVideo(video);
  publishState();

  const hrefChanged = location.href !== lastHref;
  lastHref = location.href;

  if (openedJustNow || hrefChanged || !activeSeries) {
    await resolveSeriesForPlayer();
  }

  if (matchedConfig && filterManager.hasConfig()) {
    filterManager.attachVideo(video);
  }
}

function describeVideo(video: HTMLVideoElement): string {
  const size = `${video.videoWidth || video.clientWidth}×${video.videoHeight || video.clientHeight}`;
  return `Player open · ${size}`;
}

function onNavigation(): void {
  if (location.href === lastHref && matchedConfig && isPlayerOpen()) {
    return;
  }

  lastHref = '';
  clearMatch('navigation');
  void onVideoChange(detector?.getCurrent() ?? null);
}

function watchSpaNavigation(): void {
  const pushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    pushState(...args);
    onNavigation();
  };

  const replaceState = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    replaceState(...args);
    onNavigation();
  };

  window.addEventListener('popstate', onNavigation);
}

function startConfigPolling(): void {
  pollTimer = window.setInterval(() => {
    void refreshWhilePlayerOpen(true);
  }, CONFIG_REFRESH_MS);
}

async function refreshWhilePlayerOpen(forceConfigRefresh = false): Promise<void> {
  if (contextInvalidated || !isExtensionContextValid()) {
    handleContextInvalidated();
    return;
  }

  const playerOpen = isPlayerOpen();
  if (!playerOpen) {
    if (lastPlayerOpen) {
      clearMatch('player closed');
      uiStatus = 'initialized';
      uiDetail = 'Waiting for player';
      publishState();
    }
    lastPlayerOpen = false;
    return;
  }

  lastPlayerOpen = true;
  await resolveSeriesForPlayer(forceConfigRefresh);
}

function watchPlayerGate(): void {
  window.setInterval(() => {
    const open = isPlayerOpen();
    if (!open) {
      if (lastPlayerOpen) {
        clearMatch('player closed');
        uiStatus = 'initialized';
        uiDetail = 'Waiting for player';
        publishState();
      }
      lastPlayerOpen = false;
      return;
    }

    if (!lastPlayerOpen) {
      lastPlayerOpen = true;
      void onVideoChange(detector?.getCurrent() ?? null);
    }
  }, 2000);
}

function listenForSidePanelMessages(): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'SCF_PANEL_VISIBILITY') {
      sidePanelOpen = Boolean(message.sidePanelOpen);
      if (message.state?.status) {
        // keep local status from content authority; only sync visibility
      }
      syncStatusDot();
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type !== 'SCF_SELECT_TITLE' || typeof message.titleId !== 'string') {
      return false;
    }

    const config =
      activeSeries?.candidates.find((c) => c.titleId === message.titleId) ||
      titleConfigs.find((c) => c.titleId === message.titleId);

    if (!config) {
      sendResponse({ ok: false, error: 'Unknown titleId' });
      return false;
    }

    if (!activeSeries) {
      activeSeries = {
        seriesKey: `manual:${config.titleId}`,
        seriesLabel: config.title,
        reasons: ['selected from side panel'],
        candidates: [config],
      };
    }

    applySelectedConfig(config);
    sendResponse({ ok: true });
    return false;
  });
}

function init(): void {
  statusDot.mount(openSidePanelFromDot);
  sidePanelOpen = false;
  syncStatusDot();

  uiStatus = 'initialized';
  uiDetail = 'Waiting for player — open the SCF side panel';
  publishState();
  logger.info('SCF content script starting on', location.href);

  detector = new VideoDetector((video) => {
    void onVideoChange(video);
  });
  detector.start();
  watchSpaNavigation();
  startConfigPolling();
  watchPlayerGate();
  listenForSidePanelMessages();

  void ensureConfigsLoaded();
}

init();
