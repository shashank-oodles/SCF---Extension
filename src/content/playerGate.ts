import { pickActiveVideo } from './videoDetector';
import {
  findWatchPlayerVideo,
  WATCH_PLAYER_ROOT_SELECTOR,
} from './playbackVideo';

export { findWatchPlayerVideo, WATCH_PLAYER_ROOT_SELECTOR } from './playbackVideo';

let cachedOpen: { at: number; value: boolean } | null = null;
const CACHE_MS = 250;

/**
 * True only when the full Prime Video watch player is open.
 * Detail-page hero trailers / glimpses must return false.
 *
 * Kept cheap: no full-document button scans or elementFromPoint.
 * Result is cached briefly so timers/polls don't thrash layout.
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

function computePlayerOpen(): boolean {
  // Fast path: watch-player chrome / root present
  if (!hasWatchPlayerSignals() && !isLargePlayerRoot()) {
    return false;
  }

  const video = getPrimaryPlaybackVideo();
  if (!video) return false;

  const rect = video.getBoundingClientRect();
  if (rect.width < 360 || rect.height < 200) return false;

  return true;
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
