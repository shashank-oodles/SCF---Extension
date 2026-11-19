import type { FilterInterval, PlaybackSnapshot } from '../types';
import { logger } from '../utils/logger';

/**
 * Mutes only while currentTime is inside a mute interval.
 * Seeks/jumps outside that range unmute immediately (unless the user
 * had already muted before we took over).
 */
export class MuteFilter {
  private muteIntervals: FilterInterval[] = [];
  /** True while we forced muted=true for a filter window */
  private filterOwnsMute = false;
  /** User's muted state when we first entered a mute window */
  private userMutedBeforeFilter: boolean | null = null;
  /** User manually unmuted inside a window — don't remute until they leave and re-enter */
  private userReleasedDuringInterval = false;
  private lastInRange = false;

  setIntervals(filters: FilterInterval[]): void {
    this.muteIntervals = filters
      .filter((f) => f.action === 'mute')
      .slice()
      .sort((a, b) => a.start - b.start);
  }

  reset(video: HTMLVideoElement | null = null): void {
    this.releaseMute(video);
    this.userReleasedDuringInterval = false;
    this.lastInRange = false;
  }

  detach(video: HTMLVideoElement | null): void {
    this.reset(video);
  }

  /**
   * Idempotent sync: mute iff currentTime is in a mute range.
   * Safe to call on timeupdate, seeking, and seeked.
   */
  evaluate(video: HTMLVideoElement, snapshot: PlaybackSnapshot): void {
    const t = snapshot.currentTime;
    const inRange = this.muteIntervals.some(
      (f) => t >= f.start && t < f.end
    );

    if (inRange) {
      this.syncInsideRange(video, t);
    } else {
      this.syncOutsideRange(video, t);
    }

    this.lastInRange = inRange;
  }

  private syncInsideRange(video: HTMLVideoElement, t: number): void {
    if (!this.lastInRange) {
      this.userReleasedDuringInterval = false;
      this.userMutedBeforeFilter = video.muted;

      if (video.muted) {
        this.filterOwnsMute = false;
        logger.debug('Mute interval entered; user already muted', { t });
        return;
      }

      video.muted = true;
      this.filterOwnsMute = true;
      logger.debug('Mute applied', { t });
      return;
    }

    if (this.userReleasedDuringInterval) {
      return;
    }

    if (this.filterOwnsMute) {
      if (!video.muted) {
        // User unmuted mid-interval — stay unmuted until they leave this window
        this.filterOwnsMute = false;
        this.userReleasedDuringInterval = true;
        this.userMutedBeforeFilter = null;
        logger.debug(
          'User unmuted during filter interval; releasing ownership',
          { t }
        );
      }
      return;
    }

    if (!video.muted) {
      this.userMutedBeforeFilter = false;
      video.muted = true;
      this.filterOwnsMute = true;
      logger.debug('Mute re-applied while still in range', { t });
    }
  }

  private syncOutsideRange(video: HTMLVideoElement, t: number): void {
    if (this.filterOwnsMute || this.lastInRange) {
      logger.debug('Left mute range', { t, owned: this.filterOwnsMute });
    }
    this.releaseMute(video);
    this.userReleasedDuringInterval = false;
  }

  private releaseMute(video: HTMLVideoElement | null): void {
    if (
      video &&
      this.filterOwnsMute &&
      this.userMutedBeforeFilter === false
    ) {
      video.muted = false;
      logger.debug('Mute restored (unmuted)');
    }
    this.filterOwnsMute = false;
    this.userMutedBeforeFilter = null;
  }
}
