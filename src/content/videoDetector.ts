import { logger } from '../utils/logger';
import {
  findWatchPlayerVideo,
  isInsideWatchPlayer,
} from './playbackVideo';

export type VideoChangeHandler = (video: HTMLVideoElement | null) => void;

/**
 * Scores candidate <video> elements to pick the active playback element.
 * Watch-player feature videos beat background trailers/glimpses.
 */
function scoreVideo(video: HTMLVideoElement): number {
  let score = 0;

  const width = video.videoWidth || video.clientWidth;
  const height = video.videoHeight || video.clientHeight;
  const area = width * height;

  if (area >= 320 * 180) score += 40;
  else if (area >= 160 * 90) score += 15;
  else score -= 20;

  if (!video.paused) score += 10;
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) score += 20;
  if (video.currentTime > 0.25) score += 10;
  if (!video.ended) score += 5;

  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (duration >= 30 * 60) score += 120;
  else if (duration >= 5 * 60) score += 80;
  else if (duration >= 60) score += 40;
  else if (duration > 0 && duration < 60) score -= 30;

  if (video.muted) score -= 40;
  else score += 15;

  if (isInsideWatchPlayer(video)) score += 200;

  // Avoid getComputedStyle — it forces style recalc. Use attribute/inline hints only.
  if (video.hasAttribute('hidden') || video.style.display === 'none') {
    score -= 40;
  }

  const rect = video.getBoundingClientRect();
  if (rect.width < 80 || rect.height < 45) score -= 30;
  else if (rect.width >= 480) score += 25;

  return score;
}

export function pickActiveVideo(
  candidates: HTMLVideoElement[] = Array.from(
    document.querySelectorAll('video')
  )
): HTMLVideoElement | null {
  const watchVideo = findWatchPlayerVideo();
  if (watchVideo) return watchVideo;

  if (candidates.length === 0) return null;

  let best: HTMLVideoElement | null = null;
  let bestScore = -Infinity;

  for (const video of candidates) {
    const score = scoreVideo(video);
    if (score > bestScore) {
      bestScore = score;
      best = video;
    }
  }

  if (best && bestScore < 0) return null;
  return best;
}

export class VideoDetector {
  private debounceId: number | null = null;
  private current: HTMLVideoElement | null = null;
  private readonly onChange: VideoChangeHandler;

  constructor(onChange: VideoChangeHandler) {
    this.onChange = onChange;
  }

  start(): void {
    this.scan();

    // Purely event-driven: no document-wide MutationObserver or polling loop.
    // Capturing media events fire whenever a <video> loads or starts playing.
    document.addEventListener('loadedmetadata', this.onMediaEvent, true);
    document.addEventListener('play', this.onMediaEvent, true);
    document.addEventListener('ended', this.onMediaEvent, true);

    logger.info('VideoDetector started');
  }

  stop(): void {
    document.removeEventListener('loadedmetadata', this.onMediaEvent, true);
    document.removeEventListener('play', this.onMediaEvent, true);
    document.removeEventListener('ended', this.onMediaEvent, true);
    if (this.debounceId !== null) {
      window.clearTimeout(this.debounceId);
      this.debounceId = null;
    }
    this.current = null;
  }

  private readonly onMediaEvent = (event: Event): void => {
    if (!(event.target instanceof HTMLVideoElement)) return;
    if (this.debounceId !== null) return;
    this.debounceId = window.setTimeout(() => {
      this.debounceId = null;
      this.scan();
    }, 250);
  };

  getCurrent(): HTMLVideoElement | null {
    return this.current ?? pickActiveVideo();
  }

  private scan(): void {
    const next = pickActiveVideo();
    if (next === this.current) return;

    logger.info('Active video changed', {
      from: describeVideo(this.current),
      to: describeVideo(next),
    });

    this.current = next;
    this.onChange(next);
  }
}

function describeVideo(video: HTMLVideoElement | null): string {
  if (!video) return 'none';
  const dur = Number.isFinite(video.duration) ? video.duration.toFixed(0) : '?';
  return `paused=${video.paused} muted=${video.muted} t=${video.currentTime.toFixed(2)}/${dur}s ${video.videoWidth}x${video.videoHeight}`;
}
