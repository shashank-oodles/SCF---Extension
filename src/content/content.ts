import {
  extractPrimePageInfo,
  type PrimePageInfo,
} from '../services/primeTitleExtractor';
import {
  applyPrimeNetworkMessage,
  clearPlaybackCatalog,
  findCatalogEpisode,
  getPrimeCatalog,
  pageKeyFromUrl,
  resetPrimeCatalog,
  subscribePrimeCatalog,
} from '../services/primeCatalog';
import type { ExtensionStatus } from '../types';
import type { SidePanelState } from '../types/panel';
import { logger } from '../utils/logger';
import { StatusDot } from '../utils/statusDot';
import {
  getPrimaryPlaybackVideo,
  invalidatePlayerGateCache,
  isPlayerOpen,
} from './playerGate';
import { VideoDetector } from './videoDetector';

const REFRESH_MS = 4_000;
const PLAYBACK_TICK_MS = 1_000;

const statusDot = new StatusDot();

let detected: PrimePageInfo | null = null;
let selectedEpisode: string | null = null;
let selectedGti: string | null = null;
let uiStatus: ExtensionStatus = 'initialized';
let uiDetail = 'Open a movie or show on Prime Video';
let lastHref = '';
let lastPageKey = '';
let lastFingerprint = '';
let lastPlayerOpen = false;
let detector: VideoDetector | null = null;
let sidePanelOpen = false;
let contextInvalidated = false;

function syncStatusDot(): void {
  const active = Boolean(
    (detected?.title && detected.title !== 'Unknown title') || detected?.gti
  );
  statusDot.setStatus(uiStatus, active && isPlayerOpen());
  statusDot.setVisible(!sidePanelOpen);
}

function readPlaybackTime(): number | null {
  if (!isPlayerOpen()) return null;
  const video = getPrimaryPlaybackVideo() ?? detector?.getCurrent() ?? null;
  if (!video) return null;
  return Number.isFinite(video.currentTime) ? video.currentTime : null;
}

function resetSelection(reason: string): void {
  selectedEpisode = null;
  selectedGti = null;
  detected = null;
  lastFingerprint = '';
  logger.info('Selection reset', { reason });
}

function publishState(detailOverride?: string): void {
  if (detailOverride) uiDetail = detailOverride;

  const playerOpen = isPlayerOpen();
  const gti = detected?.gti || selectedGti || undefined;
  const state: SidePanelState = {
    playerOpen,
    sidePanelOpen,
    status: uiStatus,
    statusDetail: uiDetail,
    detected: detected
      ? {
          kind: detected.kind,
          title: detected.title,
          episodeName: detected.episodeName,
          seasonLabel: detected.seasonLabel,
          gti,
          parentGti: detected.parentGti,
          pageUrl: location.href,
          episodes: detected.episodes,
          sources: detected.sources,
        }
      : null,
    selectedEpisode,
    selectedGti: gti || null,
    currentTime: playerOpen ? readPlaybackTime() : null,
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
      if (!chrome.runtime?.id) {
        contextInvalidated = true;
      }
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

function syncSelectionFromCatalog(info: PrimePageInfo): void {
  if (info.kind === 'movie') {
    selectedEpisode = null;
    selectedGti = info.gti || getPrimeCatalog().playingGti || null;
    return;
  }

  if (info.kind !== 'show') {
    if (info.gti) selectedGti = info.gti;
    return;
  }

  const catalog = getPrimeCatalog();
  const active =
    (info.gti && findCatalogEpisode(info.gti)) ||
    (catalog.playingGti && findCatalogEpisode(catalog.playingGti)) ||
    info.episodes.find((e) => e.nowPlaying) ||
    (info.episodeName
      ? info.episodes.find(
          (e) => e.name.toLowerCase() === info.episodeName!.toLowerCase()
        )
      : undefined);

  if (active?.titleId) {
    selectedGti = active.titleId;
    selectedEpisode = info.episodeName || active.name;
    return;
  }

  if (info.gti) {
    selectedGti = info.gti;
  } else if (catalog.playingGti) {
    selectedGti = catalog.playingGti;
  }

  if (info.episodeName) {
    selectedEpisode = info.episodeName;
  } else if (selectedEpisode) {
    const stillThere = info.episodes.some(
      (e) => e.name.toLowerCase() === selectedEpisode!.toLowerCase()
    );
    if (!stillThere) selectedEpisode = null;
  }
}

function refreshDetectedTitle(force = false): void {
  if (contextInvalidated) return;

  const playerOpen = isPlayerOpen();
  const pageKey = pageKeyFromUrl();

  if (lastPlayerOpen && !playerOpen) {
    clearPlaybackCatalog('player_closed');
    selectedGti = null;
    selectedEpisode = null;
    lastFingerprint = '';
    lastPlayerOpen = false;
    force = true;
  } else if (!lastPlayerOpen && playerOpen) {
    // New watch session — drop previous playing identity; keep detail episode list
    selectedGti = null;
    selectedEpisode = null;
    lastFingerprint = '';
    lastPlayerOpen = true;
    force = true;
  } else {
    lastPlayerOpen = playerOpen;
  }

  if (lastPageKey && pageKey !== lastPageKey) {
    resetPrimeCatalog(pageKey);
    resetSelection('page_changed');
    lastPageKey = pageKey;
    force = true;
  } else if (!lastPageKey) {
    lastPageKey = pageKey;
  }

  const info = extractPrimePageInfo(location.href, document.title);

  // Prefer live catalog GTI even if extractor title came from DOM
  const catalog = getPrimeCatalog();
  if (!info.gti && catalog.playingGti) {
    info.gti = catalog.playingGti;
  }
  if (info.kind === 'show' && !info.episodeName) {
    const active = info.episodes.find((e) => e.nowPlaying);
    if (active) info.episodeName = active.name;
  }

  const fingerprint = JSON.stringify({
    href: location.href,
    pageKey,
    title: info.title,
    kind: info.kind,
    episodeName: info.episodeName,
    gti: info.gti,
    episodes: info.episodes.map((e) => `${e.titleId || ''}:${e.name}:${e.nowPlaying ? 1 : 0}`),
    player: playerOpen,
    catalogAt: catalog.updatedAt,
  });

  if (!force && fingerprint === lastFingerprint) return;

  lastFingerprint = fingerprint;
  detected = info;
  syncSelectionFromCatalog(info);

  if (!info.title || info.title === 'Unknown title') {
    if (info.gti || selectedGti) {
      const gti = info.gti || selectedGti!;
      uiStatus = playerOpen ? 'filtering_active' : 'filters_loaded';
      uiDetail =
        info.kind === 'show'
          ? `${selectedEpisode || 'Episode'} · ${gti}`
          : `Title · ${gti}`;
      publishState();
      return;
    }
    uiStatus = 'title_not_matched';
    uiDetail = 'Could not read a title from this Prime page yet';
    publishState();
    return;
  }

  if (info.kind === 'show') {
    uiStatus = selectedEpisode || selectedGti
      ? playerOpen
        ? 'filtering_active'
        : 'filters_loaded'
      : 'awaiting_selection';
    uiDetail = selectedEpisode
      ? `${info.title} · ${selectedEpisode}`
      : selectedGti
        ? `${info.title} · ${selectedGti}`
        : `${info.title} · select an episode`;
  } else {
    selectedEpisode = null;
    if (info.gti) selectedGti = info.gti;
    uiStatus = playerOpen ? 'filtering_active' : 'filters_loaded';
    uiDetail =
      info.kind === 'movie'
        ? `Movie · ${info.title}`
        : `Title · ${info.title}`;
  }

  publishState();
}

function onNavigation(): void {
  const href = location.href;
  const pageKey = pageKeyFromUrl(href);

  if (href === lastHref && pageKey === lastPageKey) {
    refreshDetectedTitle();
    return;
  }

  lastHref = href;
  lastPageKey = pageKey;
  lastPlayerOpen = false;
  invalidatePlayerGateCache();
  resetPrimeCatalog(pageKey);
  resetSelection('navigation');
  uiStatus = 'initialized';
  uiDetail = 'Navigated — detecting title…';
  publishState();
  refreshDetectedTitle(true);
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

function listenForPrimeNetwork(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!applyPrimeNetworkMessage(event.data)) return;
    // applyPrimeNetworkMessage already notifies catalog subscribers
  });
  // Single refresh path — avoid double extract on every network hit
  subscribePrimeCatalog(() => {
    refreshDetectedTitle(true);
  });
}

function listenForSidePanelMessages(): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'SCF_PANEL_VISIBILITY') {
      sidePanelOpen = Boolean(message.sidePanelOpen);
      syncStatusDot();
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === 'SCF_GET_PLAYBACK_TIME') {
      const t = readPlaybackTime();
      if (t == null) {
        sendResponse({
          ok: false,
          error: 'Player is not open — start playback first',
        });
      } else {
        sendResponse({ ok: true, currentTime: t });
      }
      return false;
    }

    if (
      message?.type === 'SCF_SELECT_EPISODE' &&
      typeof message.episodeName === 'string'
    ) {
      selectedEpisode = message.episodeName;
      const fromCatalog =
        (typeof message.gti === 'string' && findCatalogEpisode(message.gti)) ||
        findCatalogEpisode(message.episodeName);
      selectedGti =
        fromCatalog?.titleId ||
        (typeof message.gti === 'string' ? message.gti : selectedGti);

      if (detected) {
        detected = {
          ...detected,
          episodeName: message.episodeName,
          gti: selectedGti || detected.gti,
          kind: 'show',
        };
      }
      const playing = isPlayerOpen();
      uiStatus = playing ? 'filtering_active' : 'filters_loaded';
      uiDetail = detected
        ? `${detected.title} · ${message.episodeName}`
        : message.episodeName;
      publishState();
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });
}

function init(): void {
  statusDot.mount(openSidePanelFromDot);
  sidePanelOpen = false;
  syncStatusDot();

  uiStatus = 'initialized';
  uiDetail = 'Open a movie or show on Prime Video';
  publishState();
  logger.info('SCF content script starting on', location.href);

  detector = new VideoDetector(() => {
    refreshDetectedTitle(true);
  });
  detector.start();

  listenForPrimeNetwork();
  watchSpaNavigation();
  listenForSidePanelMessages();

  lastHref = location.href;
  lastPageKey = pageKeyFromUrl();
  lastPlayerOpen = isPlayerOpen();
  resetPrimeCatalog(lastPageKey);
  refreshDetectedTitle(true);

  window.setInterval(() => {
    if (!contextInvalidated) refreshDetectedTitle();
  }, REFRESH_MS);

  // Light tick for side-panel clock only — no title re-extract
  window.setInterval(() => {
    if (contextInvalidated || !sidePanelOpen || !isPlayerOpen()) return;
    publishState();
  }, PLAYBACK_TICK_MS);
}

init();
