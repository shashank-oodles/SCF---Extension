import { pickActiveVideo } from './videoDetector';

/**
 * True only when the Prime Video playback UI / active player video is open.
 * Detail pages (episode lists, trailers) should not run title matching.
 */
export function isPlayerOpen(): boolean {
  const playerChrome = document.querySelector(
    [
      '.atvwebplayersdk-infobar-container',
      '.atvwebplayersdk-title-text',
      '.atvwebplayersdk-subtitle-text',
      '.atvwebplayersdk-player-container',
      '.webPlayerSDKContainer',
      '#dv-web-player',
      '.dv-player-container',
      '[class*="atvwebplayersdk-"]',
    ].join(', ')
  );

  const video = pickActiveVideo();
  if (!video) return false;

  const rect = video.getBoundingClientRect();
  const largeEnough = rect.width >= 300 && rect.height >= 160;
  if (!largeEnough) return false;

  const hasPlaybackSignal =
    !video.paused ||
    video.currentTime > 0.4 ||
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;

  // Prefer real player chrome when present; otherwise require a substantial video.
  if (playerChrome) return hasPlaybackSignal;

  // Fallback: big video that is clearly in playback (not a tiny preview tile)
  return hasPlaybackSignal && rect.width >= 480;
}

export function describePlayerGate(): string {
  return isPlayerOpen() ? 'player open' : 'waiting for player';
}
