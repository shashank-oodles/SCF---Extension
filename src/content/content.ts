import {
  fetchAllTitleConfigs,
  matchTitleConfig,
} from '../services/filterApi';
import type { TitleFilterConfig } from '../types';
import { logger } from '../utils/logger';
import { StatusIndicator } from '../utils/statusIndicator';
import { FilterManager } from './filterManager';
import { VideoDetector } from './videoDetector';

const status = new StatusIndicator();
const filterManager = new FilterManager((s, detail) => status.setStatus(s, detail));

let titleConfigs: TitleFilterConfig[] = [];
let matchedConfig: TitleFilterConfig | null = null;
let lastHref = '';
let loadingFilters = false;
let detector: VideoDetector | null = null;

async function ensureConfigsLoaded(): Promise<boolean> {
  if (titleConfigs.length > 0) return true;
  if (loadingFilters) return false;

  loadingFilters = true;
  try {
    titleConfigs = await fetchAllTitleConfigs();
    logger.info('Loaded title configs', titleConfigs.length);
    return true;
  } catch (err) {
    status.setStatus(
      'backend_failed',
      err instanceof Error ? err.message : 'API error'
    );
    logger.error('Failed to load title configs', err);
    return false;
  } finally {
    loadingFilters = false;
  }
}

async function resolveTitleForPage(): Promise<TitleFilterConfig | null> {
  const ok = await ensureConfigsLoaded();
  if (!ok) return null;

  const match = matchTitleConfig(titleConfigs, location.href, document.title);
  if (!match) {
    logger.warn('Title not matched', {
      href: location.href,
      title: document.title,
      patterns: titleConfigs.flatMap((c) => c.matchPatterns),
    });
    status.setStatus(
      'title_not_matched',
      'Update matchPatterns in backend filters.json'
    );
    matchedConfig = null;
    return null;
  }

  matchedConfig = match;
  filterManager.loadConfig(match);
  logger.info('Title matched', match.titleId, match.title);
  return match;
}

async function onVideoChange(video: HTMLVideoElement | null): Promise<void> {
  filterManager.detachVideo();

  if (!video) {
    status.setStatus('initialized', 'Waiting for video');
    return;
  }

  status.setStatus('video_detected', describeVideo(video));

  const hrefChanged = location.href !== lastHref;
  if (hrefChanged || !matchedConfig) {
    lastHref = location.href;
    const config = await resolveTitleForPage();
    if (!config) return;
  }

  if (!filterManager.hasConfig() && matchedConfig) {
    filterManager.loadConfig(matchedConfig);
  }

  if (filterManager.hasConfig()) {
    filterManager.attachVideo(video);
  }
}

function describeVideo(video: HTMLVideoElement): string {
  const size = `${video.videoWidth || video.clientWidth}×${video.videoHeight || video.clientHeight}`;
  return size;
}

function onNavigation(): void {
  if (location.href === lastHref && matchedConfig) {
    // Title-only updates should not drop a good match
    return;
  }

  lastHref = '';
  matchedConfig = null;
  filterManager.detachVideo();
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

function init(): void {
  status.mount();
  status.setStatus('initialized');
  logger.info('SCF content script starting on', location.href);

  detector = new VideoDetector((video) => {
    void onVideoChange(video);
  });
  detector.start();
  watchSpaNavigation();

  void ensureConfigsLoaded().then((ok) => {
    if (ok) void resolveTitleForPage();
  });
}

init();
