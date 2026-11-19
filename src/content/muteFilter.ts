import type { FilterInterval, PlaybackSnapshot } from '../types';
import { logger } from '../utils/logger';

/**
 * Applies timestamp-based mute intervals while preserving the user's
 * intentional mute preference outside filter windows.
 */
export class MuteFilter {
  private muteIntervals: FilterInterval[] = [];
  private activeIds = new Set<string>();
  private userMutedBeforeFilter: boolean | null = null;
  private filterOwnsMute = false;

  setIntervals(filters: FilterInterval[]): void {
    this.muteIntervals = filters
      .filter((f) => f.action === 'mute')
      .slice()
      .sort((a, b) => a.start - b.start);
    this.activeIds.clear();
  }

  reset(): void {
    this.activeIds.clear();
    this.userMutedBeforeFilter = null;
    this.filterOwnsMute = false;
  }

  /**
   * Call when the video element is replaced so we do not restore mute onto
   * a different element incorrectly.
   */
  detach(video: HTMLVideoElement | null): void {
    if (video && this.filterOwnsMute && this.userMutedBeforeFilter === false) {
      video.muted = false;
    }
    this.reset();
  }

  evaluate(video: HTMLVideoElement, snapshot: PlaybackSnapshot): void {
    const t = snapshot.currentTime;
    const overlapping = this.muteIntervals.filter(
      (f) => t >= f.start && t < f.end
    );
    const nextIds = new Set(overlapping.map((f) => f.id));

    const wasActive = this.activeIds.size > 0;
    const nowActive = nextIds.size > 0;

    if (!wasActive && nowActive) {
      // Entering mute region(s) — remember user mute preference once
      this.userMutedBeforeFilter = video.muted;
      if (!video.muted) {
        video.muted = true;
        this.filterOwnsMute = true;
        logger.debug('Mute applied', { t, ids: [...nextIds] });
      } else {
        // User already muted; do not claim ownership
        this.filterOwnsMute = false;
        logger.debug('Mute interval entered; user already muted', { t });
      }
    } else if (wasActive && !nowActive) {
      // Exiting all mute regions
      if (this.filterOwnsMute && this.userMutedBeforeFilter === false) {
        video.muted = false;
        logger.debug('Mute restored (unmuted)', { t });
      } else {
        logger.debug('Mute interval exited; preserving user mute state', { t });
      }
      this.userMutedBeforeFilter = null;
      this.filterOwnsMute = false;
    } else if (nowActive && this.filterOwnsMute && !video.muted) {
      // User unmuted mid-interval — stop owning mute for this stretch
      this.filterOwnsMute = false;
      this.userMutedBeforeFilter = false;
      logger.debug('User unmuted during filter interval; releasing ownership');
    }

    // Overlapping consecutive intervals: keep muted while any remain active
    if (nowActive && this.filterOwnsMute && !video.muted) {
      video.muted = true;
    }

    this.activeIds = nextIds;
  }

  getActiveIds(): string[] {
    return [...this.activeIds];
  }
}
