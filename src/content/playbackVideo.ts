/**
 * Shared helpers to find the real watch-player <video>, not a hero trailer.
 */

export const WATCH_PLAYER_ROOT_SELECTOR = [
  '#dv-web-player',
  '.webPlayerSDKContainer',
  '.atvwebplayersdk-player-container',
  '.dv-player-fullscreen',
  '[class*="webPlayerSDK"]',
].join(', ');

export function isInsideWatchPlayer(video: HTMLVideoElement): boolean {
  return Boolean(video.closest(WATCH_PLAYER_ROOT_SELECTOR));
}

/**
 * Prefer the longest-duration video inside the watch player.
 * Feature films beat short trailer loops even when the feature is paused.
 */
export function findWatchPlayerVideo(): HTMLVideoElement | null {
  const roots = document.querySelectorAll(WATCH_PLAYER_ROOT_SELECTOR);

  let best: HTMLVideoElement | null = null;
  let bestScore = -Infinity;

  for (const root of Array.from(roots)) {
    for (const video of Array.from(root.querySelectorAll('video'))) {
      if (!(video instanceof HTMLVideoElement)) continue;
      const rect = video.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const score =
        (duration >= 60 ? duration : 0) +
        area / 1000 +
        (video.muted ? -50 : 20) +
        (rect.width >= 200 ? 50 : -100);

      if (score > bestScore) {
        best = video;
        bestScore = score;
      }
    }
  }
  return best;
}
