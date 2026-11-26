import { pickActiveVideo } from './videoDetector';
import {
  findWatchPlayerVideo,
  WATCH_PLAYER_ROOT_SELECTOR,
} from './playbackVideo';

export { findWatchPlayerVideo, WATCH_PLAYER_ROOT_SELECTOR } from './playbackVideo';

let cachedOpen: { at: number; value: boolean } | null = null;
const CACHE_MS = 500;

/**
 * True only when the full Prime Video watch player is open.
 * Detail-page hero trailers / glimpses must return false.
 *
 * Result is cached briefly so timers/events don't thrash layout.
 */
export function isPlayerOpen(): boolean {
  const now = Date.now();
  if (cachedOpen && now - cachedOpen.at < CACHE_MS) {
    return cachedOpen.value;
  }

  const value = computePlayerOpen();
  cachedOpen = { at: now, value };
  return value;
}

export function invalidatePlayerGateCache(): void {
  cachedOpen = null;
}

/** The watch player only ever runs on a title's /detail/ URL. */
function isDetailUrl(): boolean {
  return /\/detail\/[A-Za-z0-9]+/i.test(location.pathname);
}

function computePlayerOpen(): boolean {
  // Home/browse hero trailers can use the same player markup; they never
  // live on a detail URL, so reject them before any DOM work.
  if (!isDetailUrl()) return false;

  // Fast path: watch-player chrome / root present
  if (!hasWatchPlayerSignals() && !isLargePlayerRoot()) {
    return false;
  }

  const video = getPrimaryPlaybackVideo();
  if (!video) return false;

  const rect = video.getBoundingClientRect();
  if (rect.width < 360 || rect.height < 200) return false;

  return isWatchPlayerOnTop(video);
}

/**
 * The closed player's DOM lingers and the detail-page hero trailer is also
 * a large <video>, so presence isn't enough: the full-screen watch player
 * must be what's rendered at the viewport centre. One hit-test per cache window.
 */
function isWatchPlayerOnTop(video: HTMLVideoElement): boolean {
  const top = document.elementFromPoint(
    window.innerWidth / 2,
    window.innerHeight / 2
  );
  if (!top) return false;
  if (top === video || video.contains(top)) {
    return Boolean(video.closest(WATCH_PLAYER_ROOT_SELECTOR));
  }
  return Boolean(top.closest(WATCH_PLAYER_ROOT_SELECTOR));
}

/**
 * The video element to read/seek/mute — always prefer the watch-player
 * video over background trailers/glimpses (which keep playing when paused).
 */
export function getPrimaryPlaybackVideo(): HTMLVideoElement | null {
  return findWatchPlayerVideo() ?? pickActiveVideo();
}

function hasWatchPlayerSignals(): boolean {
  return Boolean(
    document.querySelector(
      [
        '.atvwebplayersdk-title-text',
        '.atvwebplayersdk-subtitle-text',
        '.atvwebplayersdk-infobar-container',
        '.atvwebplayersdk-seekbar-container',
        '.atvwebplayersdk-playpause-button',
        '.atvwebplayersdk-overlays-container',
        '#dv-web-player',
        '.webPlayerSDKContainer',
        'button[aria-label="Close player"]',
      ].join(', ')
    )
  );
}

function isLargePlayerRoot(): boolean {
  const roots = document.querySelectorAll(WATCH_PLAYER_ROOT_SELECTOR);

  for (const root of Array.from(roots)) {
    if (!(root instanceof HTMLElement)) continue;
    const rect = root.getBoundingClientRect();
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    const viewport = window.innerWidth * window.innerHeight;
    if (viewport > 0 && area >= viewport * 0.4) return true;
    if (rect.width >= 640 && rect.height >= 360) return true;
  }
  return false;
}

export function describePlayerGate(): string {
  return isPlayerOpen() ? 'player open' : 'waiting for player';
}
