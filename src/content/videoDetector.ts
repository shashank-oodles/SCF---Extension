import { logger } from '../utils/logger';

export type VideoChangeHandler = (video: HTMLVideoElement | null) => void;

/**
 * Scores candidate <video> elements to pick the active playback element.
 * Avoids tiny placeholders / ads preview tiles when possible.
 */
function scoreVideo(video: HTMLVideoElement): number {
  let score = 0;

  const width = video.videoWidth || video.clientWidth;
  const height = video.videoHeight || video.clientHeight;
  const area = width * height;

  if (area >= 320 * 180) score += 40;
  else if (area >= 160 * 90) score += 15;
  else score -= 20;

  if (!video.paused) score += 50;
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) score += 20;
  if (video.currentTime > 0.25) score += 25;
  if (!video.ended) score += 5;
  if (video.disablePictureInPicture === false) score += 2;

  // Prefer elements that are actually visible
  const style = window.getComputedStyle(video);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    score -= 40;
  }

  const rect = video.getBoundingClientRect();
  if (rect.width < 80 || rect.height < 45) score -= 30;

  return score;
}

export function pickActiveVideo(
  candidates: HTMLVideoElement[] = Array.from(
    document.querySelectorAll('video')
  )
): HTMLVideoElement | null {
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

  // Reject clearly non-playback placeholders
  if (best && bestScore < 0) return null;
  return best;
}

export class VideoDetector {
  private observer: MutationObserver | null = null;
  private pollId: number | null = null;
  private current: HTMLVideoElement | null = null;
  private readonly onChange: VideoChangeHandler;
  private readonly pollMs: number;

  constructor(onChange: VideoChangeHandler, pollMs = 1500) {
    this.onChange = onChange;
    this.pollMs = pollMs;
  }

  start(): void {
    this.scan();

    this.observer = new MutationObserver(() => this.scan());
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Poll as a safety net for attribute/readyState changes without DOM mutations
    this.pollId = window.setInterval(() => this.scan(), this.pollMs);
    logger.info('VideoDetector started');
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.pollId !== null) {
      window.clearInterval(this.pollId);
      this.pollId = null;
    }
    this.current = null;
  }

  getCurrent(): HTMLVideoElement | null {
    return this.current;
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
  return `paused=${video.paused} t=${video.currentTime.toFixed(2)} ${video.videoWidth}x${video.videoHeight}`;
}
