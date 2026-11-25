import {
  extractPrimePageInfo,
  looksLikeShowDetailPage,
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
import {
  tryResolveFiltersByQuery,
} from '../services/filterApi';
import type { ExtensionStatus, TitleFilterConfig } from '../types';
import type { SidePanelState } from '../types/panel';
import { logger } from '../utils/logger';
import { StatusDot } from '../utils/statusDot';
import { contentTimeOf, isAdPlaying, resetContentClock } from './contentClock';
import { FilterManager } from './filterManager';
import {
  getPrimaryPlaybackVideo,
  invalidatePlayerGateCache,
  isPlayerOpen,
} from './playerGate';
import { VideoDetector } from './videoDetector';

const REFRESH_MS = 4_000;
const PLAYBACK_TICK_MS = 1_000;
const FILTER_SYNC_MS = 8_000;

const statusDot = new StatusDot();
const filterManager = new FilterManager((status, detail) => {
  uiStatus = status;
  if (detail) uiDetail = detail;
  publishState();
});

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
let filterSyncGti = '';
let filterSyncInFlight = false;
let openedPanelForPlayback = false;

function syncStatusDot(): void {
  const active = Boolean(
    (detected?.title && detected.title !== 'Unknown title') || detected?.gti
  );
  statusDot.setStatus(uiStatus, active && isPlayerOpen());
  statusDot.setVisible(!sidePanelOpen);
}

/** Title (content) time, excluding stitched-in ad time. */
function readPlaybackTime(): number | null {
  if (!isPlayerOpen()) return null;
  const video = getPrimaryPlaybackVideo() ?? detector?.getCurrent() ?? null;
  if (!video || !Number.isFinite(video.currentTime)) return null;
  return contentTimeOf(video);
}

function resetSelection(reason: string): void {
  selectedEpisode = null;
  selectedGti = null;
  detected = null;
  lastFingerprint = '';
  filterSyncGti = '';
  filterManager.destroy();
  logger.info('Selection reset', { reason });
}

function activePlaybackGti(): string | null {
  return selectedGti || detected?.gti || getPrimeCatalog().playingGti || null;
}

function emptyConfigForGti(gti: string): TitleFilterConfig {
  return {
    titleId: `pending:${gti}`,
    title: detected?.title || 'Prime title',
    kind: detected?.kind === 'show' ? 'show' : 'movie',
    episodeName: selectedEpisode || detected?.episodeName,
    gti,
    provider: 'prime-video',
    videoUrl: detected?.pageUrl || `gti://${gti}`,
    matchPatterns: [gti],
    filters: [],
  };
}

async function syncPlaybackFilters(force = false): Promise<void> {
  if (contextInvalidated || filterSyncInFlight) return;

  const playerOpen = isPlayerOpen();
  const gti = activePlaybackGti();
  const video = getPrimaryPlaybackVideo();

  if (!playerOpen || !gti || !video) {
    filterManager.detachVideo();
    filterSyncGti = '';
    return;
  }

  if (!force && filterSyncGti === gti && filterManager.isActive()) {
    return;
  }

  filterSyncInFlight = true;
  try {
    const config =
      (await tryResolveFiltersByQuery(gti)) || emptyConfigForGti(gti);
    if (contextInvalidated) return;
    if (activePlaybackGti() !== gti || !isPlayerOpen()) return;

    filterManager.loadConfig(config);
    filterManager.attachVideo(video);
    filterSyncGti = gti;
    logger.info('Playback filters synced', {
      gti,
      count: config.filters.length,
    });
  } catch (err) {
    logger.warn('Failed to sync playback filters', err);
    uiStatus = 'backend_failed';
    uiDetail = 'Could not load filters from backend';
    publishState();
  } finally {
    filterSyncInFlight = false;
  }
}

function maybeOpenPanelForPlayback(): void {
  if (openedPanelForPlayback || sidePanelOpen) return;
  if (!isPlayerOpen() || !activePlaybackGti()) return;
  openedPanelForPlayback = true;
  openSidePanelFromDot();
}

let lastPublishedSignature = '';

/** Lightweight clock update for the side panel — no title/episode payload. */
function publishPlaybackTime(): void {
  const currentTime = readPlaybackTime();
  void chrome.runtime
    .sendMessage({
      type: 'SCF_TIME_UPDATE',
      playerOpen: currentTime != null,
      currentTime,
      adPlaying: currentTime != null && isAdPlaying(),
    })
    .catch(() => {
      if (!chrome.runtime?.id) contextInvalidated = true;
    });
}

function publishState(detailOverride?: string): void {
  if (detailOverride) uiDetail = detailOverride;

  const playerOpen = isPlayerOpen();
  const gti = detected?.gti || selectedGti || undefined;

  // Skip identical full-state sends; the clock travels separately.
  const signature = JSON.stringify([
    playerOpen,
    uiStatus,
    uiDetail,
    selectedEpisode,
    gti,
    detected?.title,
    detected?.kind,
    detected?.episodeName,
    detected?.seasonLabel,
    detected?.episodes.map((e) => `${e.titleId || ''}:${e.name}:${e.nowPlaying ? 1 : 0}`),
  ]);
  syncStatusDot();
  if (signature === lastPublishedSignature) return;
  lastPublishedSignature = signature;

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
    openedPanelForPlayback = false;
    filterManager.detachVideo();
    filterSyncGti = '';
    force = true;
  } else if (!lastPlayerOpen && playerOpen) {
    // New watch session — drop previous playing identity; keep detail episode list
    selectedGti = null;
    selectedEpisode = null;
    lastFingerprint = '';
    lastPlayerOpen = true;
    openedPanelForPlayback = false;
    resetContentClock();
    force = true;
    // Deferred: replay notifies catalog subscribers, which re-enter this function.
    window.setTimeout(replayPendingNetwork, 0);
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

  const info = extractPrimePageInfo(location.href, document.title, playerOpen);

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
      maybeOpenPanelForPlayback();
      void syncPlaybackFilters();
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
  maybeOpenPanelForPlayback();
  void syncPlaybackFilters();
}

function onNavigation(): void {
  const href = location.href;
  const pageKey = pageKeyFromUrl(href);
  lastHref = href;

  // Query-string churn on the same title is not a new page.
  if (pageKey === lastPageKey) {
    refreshDetectedTitle();
    return;
  }

  lastPageKey = pageKey;
  lastPlayerOpen = false;
  // Prime may fetch the new title's metadata before the URL changes.
  const cutoff = Date.now() - PENDING_NETWORK_MS;
  const prefetched = pendingNetwork
    .filter((p) => p.at >= cutoff && isCatalogCandidate(p.data))
    .pop()?.data;
  pendingNetwork.length = 0;
  pendingDetailMovie = null;
  invalidatePlayerGateCache();
  resetPrimeCatalog(pageKey);
  resetSelection('navigation');
  uiStatus = 'initialized';
  uiDetail = 'Navigated — detecting title…';
  publishState();
  refreshDetectedTitle(true);
  if (prefetched) queueDetailIdentity(prefetched);
}

/**
 * SPA navigation is announced by the MAIN-world hook (page-world history
 * calls are invisible here). A cheap href poll covers anything it misses.
 */
function watchSpaNavigation(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data as { source?: string; type?: string } | null;
    if (data?.source === 'SCF_PRIME_NETWORK' && data.type === 'navigation') {
      onNavigation();
    }
  });
  window.addEventListener('popstate', onNavigation);
  window.setInterval(() => {
    if (!contextInvalidated && location.href !== lastHref) onNavigation();
  }, 1_000);
}

const PENDING_NETWORK_MS = 10_000;
const pendingNetwork: Array<{ at: number; data: Record<string, unknown> }> = [];

function isCatalogMessage(data: unknown): data is Record<string, unknown> {
  return (
    Boolean(data) &&
    typeof data === 'object' &&
    (data as Record<string, unknown>).source === 'SCF_PRIME_NETWORK' &&
    (data as Record<string, unknown>).type === 'catalog'
  );
}

/**
 * Outside the watch player (detail-page hero trailer) keep only the show's
 * episode list; drop any "now playing" identity, which belongs to the trailer.
 */
function toEpisodeListOnly(
  msg: Record<string, unknown>
): Record<string, unknown> | null {
  if (msg.api !== 'playerChrome') return null;
  const episodes = Array.isArray(msg.episodes) ? msg.episodes : [];
  if (episodes.length === 0) return null;
  return {
    ...msg,
    contentKind: 'show',
    playingGti: null,
    focusEpisodeId: null,
    movieTitle: null,
    episodeTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    gtis: [],
  };
}

function normalizeTitle(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function readDetailPageTitle(): string {
  const h1 = document.querySelector('h1');
  const fromH1 =
    h1?.textContent?.trim() ||
    h1?.querySelector('img')?.getAttribute('alt')?.trim() ||
    '';
  if (fromH1) return fromH1;
  return document.title
    .replace(/^prime video:\s*/i, '')
    .replace(/\s*[|–—-]\s*prime video.*$/i, '')
    .trim();
}

function titlesMatch(a: string, b: string): boolean {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x));
}

/** "Resume S2 E6" / "Play S1 E1" on the detail page's primary button. */
function readResumeEpisodeLabel(): { season: number; episode: number } | null {
  const candidates = document.querySelectorAll('main button, main a[href*="/detail/"], [data-testid*="play" i]');
  const max = Math.min(candidates.length, 40);
  for (let i = 0; i < max; i++) {
    const match = candidates[i].textContent?.match(/\bS(\d+)\s*E(\d+)\b/i);
    if (match) return { season: Number(match[1]), episode: Number(match[2]) };
  }
  return null;
}

function isCatalogCandidate(msg: Record<string, unknown>): boolean {
  return (
    msg.api === 'playerChrome' &&
    typeof msg.playingGti === 'string' &&
    (typeof msg.movieTitle === 'string' || typeof msg.seriesTitle === 'string')
  );
}

/**
 * Detail-page play/resume metadata (catalogMetadataV2 + playbackRestrictions)
 * is trusted only if it describes this page — the hero trailer fires the same
 * call with its own entity.
 */
function isDetailPageIdentity(msg: Record<string, unknown>): boolean {
  if (!isCatalogCandidate(msg)) return false;
  const heading = readDetailPageTitle();

  if (msg.contentKind === 'movie') {
    if (getPrimeCatalog().episodes.length > 0 || looksLikeShowDetailPage()) {
      return false;
    }
    return titlesMatch(String(msg.movieTitle), heading);
  }

  if (msg.contentKind === 'show') {
    if (typeof msg.seasonNumber !== 'number' || typeof msg.episodeNumber !== 'number') {
      return false;
    }
    if (!titlesMatch(String(msg.seriesTitle || ''), heading)) return false;
    const resume = readResumeEpisodeLabel();
    return (
      !resume ||
      (resume.season === msg.seasonNumber && resume.episode === msg.episodeNumber)
    );
  }
  return false;
}

let pendingDetailMovie: Record<string, unknown> | null = null;
const DETAIL_RETRY_MS = [500, 1_500, 3_000, 6_000];

function queueDetailIdentity(msg: Record<string, unknown>): void {
  pendingDetailMovie = msg;
  tryApplyDetailMovie();
  if (!pendingDetailMovie) return;
  for (const delay of DETAIL_RETRY_MS) {
    window.setTimeout(() => {
      if (pendingDetailMovie === msg) tryApplyDetailMovie();
    }, delay);
  }
}
let recheckScheduled = false;

/**
 * Prime's player calls arrive just before the player is detectable; re-check
 * shortly instead of waiting for the periodic refresh to replay them.
 */
function schedulePlayerRecheck(): void {
  if (recheckScheduled) return;
  recheckScheduled = true;
  for (const delay of [300, 1_000]) {
    window.setTimeout(() => {
      invalidatePlayerGateCache();
      refreshDetectedTitle();
      if (delay === 1_000) recheckScheduled = false;
    }, delay);
  }
}

/** The metadata call can land before the page heading renders; retry briefly. */
function tryApplyDetailMovie(): void {
  if (!pendingDetailMovie || isPlayerOpen()) return;
  if (isDetailPageIdentity(pendingDetailMovie)) {
    const msg = pendingDetailMovie;
    pendingDetailMovie = null;
    applyPrimeNetworkMessage(msg);
  }
}

/** Player APIs often fire just before the player DOM is detectable. */
function replayPendingNetwork(): void {
  const cutoff = Date.now() - PENDING_NETWORK_MS;
  const recent = pendingNetwork.filter((p) => p.at >= cutoff);
  pendingNetwork.length = 0;
  for (const { data } of recent) applyPrimeNetworkMessage(data);
}

function listenForPrimeNetwork(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!isCatalogMessage(data)) {
      applyPrimeNetworkMessage(data);
      return;
    }

    if (isPlayerOpen()) {
      applyPrimeNetworkMessage(data);
      return;
    }

    pendingNetwork.push({ at: Date.now(), data });
    if (pendingNetwork.length > 8) pendingNetwork.shift();
    schedulePlayerRecheck();

    const listOnly = toEpisodeListOnly(data);
    if (listOnly) applyPrimeNetworkMessage(listOnly);

    if (isCatalogCandidate(data)) queueDetailIdentity(data);
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
      if (isPlayerOpen() && isAdPlaying()) {
        sendResponse({
          ok: false,
          error: 'Ad is playing — wait for the title to resume',
        });
        return false;
      }
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
      void syncPlaybackFilters(true);
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === 'SCF_FILTERS_CHANGED') {
      void syncPlaybackFilters(true).then(() => {
        sendResponse({ ok: true });
      });
      return true;
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
    if (!contextInvalidated && !document.hidden) refreshDetectedTitle();
  }, REFRESH_MS);

  // Clock-only tick, sent only while the side panel is visible.
  window.setInterval(() => {
    if (contextInvalidated || !sidePanelOpen || document.hidden) return;
    if (!isPlayerOpen()) return;
    publishPlaybackTime();
  }, PLAYBACK_TICK_MS);

  window.setInterval(() => {
    if (!contextInvalidated && isPlayerOpen()) {
      void syncPlaybackFilters();
    }
  }, FILTER_SYNC_MS);
}

init();
