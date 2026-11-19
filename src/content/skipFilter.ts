import type { FilterInterval, PlaybackSnapshot } from '../types';
import { logger } from '../utils/logger';

/**
 * Applies timestamp-based skip intervals with seek-loop protection.
 */
export class SkipFilter {
  private skipIntervals: FilterInterval[] = [];
  private pendingSeek = false;
  private pendingTarget: number | null = null;
  private lastCompletedSkipId: string | null = null;
  private lastCompletedAt = 0;
  /** Filters already skipped for the current contiguous pass through them */
  private completedIds = new Set<string>();

  setIntervals(filters: FilterInterval[]): void {
    this.skipIntervals = filters
      .filter((f) => f.action === 'skip')
      .slice()
      .sort((a, b) => a.start - b.start);
    this.resetExecutionState();
  }

  resetExecutionState(): void {
    this.pendingSeek = false;
    this.pendingTarget = null;
    this.lastCompletedSkipId = null;
    this.lastCompletedAt = 0;
    this.completedIds.clear();
  }

  onSeeking(): void {
    // Manual or programmatic seeking in progress
  }

  onSeeked(snapshot: PlaybackSnapshot): void {
    if (!this.pendingSeek) {
      // Manual seek — re-evaluate completed set against new position
      this.reconcileCompleted(snapshot.currentTime);
      return;
    }

    const target = this.pendingTarget;
    this.pendingSeek = false;
    this.pendingTarget = null;

    if (target !== null && Math.abs(snapshot.currentTime - target) < 1.0) {
      logger.debug('Skip seek completed', { at: snapshot.currentTime, target });
    } else {
      logger.warn('Skip seek ended away from target', {
        at: snapshot.currentTime,
        target,
      });
    }
  }

  evaluate(video: HTMLVideoElement, snapshot: PlaybackSnapshot): void {
    if (snapshot.seeking || this.pendingSeek) return;
    if (snapshot.ended) return;

    const t = snapshot.currentTime;

    // Drop completed markers when the user seeks before those intervals
    this.reconcileCompleted(t);

    const hit = this.skipIntervals.find(
      (f) =>
        t >= f.start &&
        t < f.end - 0.05 &&
        !this.completedIds.has(f.id) &&
        !(this.lastCompletedSkipId === f.id && performance.now() - this.lastCompletedAt < 750)
    );

    if (!hit) return;

    this.pendingSeek = true;
    this.pendingTarget = hit.end;
    this.completedIds.add(hit.id);
    this.lastCompletedSkipId = hit.id;
    this.lastCompletedAt = performance.now();

    logger.info('Skipping interval', {
      id: hit.id,
      from: t,
      to: hit.end,
    });

    try {
      video.currentTime = hit.end;
    } catch (err) {
      this.pendingSeek = false;
      this.pendingTarget = null;
      this.completedIds.delete(hit.id);
      logger.error('Failed to seek for skip filter', err);
    }
  }

  isSeekPending(): boolean {
    return this.pendingSeek;
  }

  private reconcileCompleted(currentTime: number): void {
    for (const interval of this.skipIntervals) {
      // If playback is before the interval, allow it to fire again later
      if (currentTime < interval.start - 0.25) {
        this.completedIds.delete(interval.id);
      }
    }
  }
}
