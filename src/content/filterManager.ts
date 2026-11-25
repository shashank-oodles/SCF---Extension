import type {
  ExtensionStatus,
  PlaybackSnapshot,
  TitleFilterConfig,
} from '../types';
import type { PlaybackEventName } from './playbackMonitor';
import { PlaybackMonitor } from './playbackMonitor';
import { MuteFilter } from './muteFilter';
import { SkipFilter } from './skipFilter';
import { logger } from '../utils/logger';

export type StatusUpdater = (status: ExtensionStatus, detail?: string) => void;

/**
 * Coordinates mute/skip filters against playback events for one video element.
 */
export class FilterManager {
  private readonly monitor = new PlaybackMonitor();
  private readonly muteFilter = new MuteFilter();
  private readonly skipFilter = new SkipFilter();
  private config: TitleFilterConfig | null = null;
  private unsubscribe: (() => void) | null = null;
  private active = false;
  private readonly onStatus: StatusUpdater;

  constructor(onStatus: StatusUpdater) {
    this.onStatus = onStatus;
  }

  loadConfig(config: TitleFilterConfig): void {
    this.config = config;
    this.muteFilter.setIntervals(config.filters);
    this.skipFilter.setIntervals(config.filters);
    this.onStatus(
      'filters_loaded',
      `${config.title} · ${config.filters.length} rules`
    );
    logger.info('Filter config loaded', {
      titleId: config.titleId,
      count: config.filters.length,
    });
  }

  attachVideo(video: HTMLVideoElement): void {
    this.detachVideo();

    if (!this.config) {
      logger.warn('Cannot attach filters without a loaded config');
      return;
    }

    this.unsubscribe = this.monitor.subscribe((event, snapshot) => {
      this.handlePlayback(event, snapshot, video);
    });
    this.monitor.attach(video);
    this.active = true;
    this.onStatus('filtering_active', this.config.title);
  }

  detachVideo(): void {
    const video = this.monitor.getVideo();
    this.muteFilter.detach(video);
    this.skipFilter.resetExecutionState();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.monitor.detach();
    this.active = false;
  }

  hasConfig(): boolean {
    return this.config !== null;
  }

  getConfig(): TitleFilterConfig | null {
    return this.config;
  }

  isActive(): boolean {
    return this.active;
  }

  destroy(): void {
    this.detachVideo();
    this.config = null;
  }

  private handlePlayback(
    event: PlaybackEventName,
    snapshot: PlaybackSnapshot,
    video: HTMLVideoElement
  ): void {
    if (event === 'seeking') {
      this.skipFilter.onSeeking();
      // Sync mute immediately to the seek target so jumps out of a mute
      // window unmute without waiting for seeked.
      this.muteFilter.evaluate(video, snapshot);
      return;
    }

    if (event === 'seeked') {
      this.skipFilter.onSeeked(snapshot);
      // Re-evaluate immediately after seek settles
      this.muteFilter.evaluate(video, snapshot);
      this.skipFilter.evaluate(video, snapshot);
      return;
    }

    if (event === 'ended') {
      this.muteFilter.reset(video);
      this.skipFilter.resetExecutionState();
      return;
    }

    if (snapshot.adPlaying) {
      // Release any filter-owned mute; ad time is not title time.
      this.muteFilter.reset(video);
      return;
    }

    // Skip evaluation while buffering if a seek is already pending
    if (snapshot.waiting && this.skipFilter.isSeekPending()) return;

    this.muteFilter.evaluate(video, snapshot);
    this.skipFilter.evaluate(video, snapshot);

    if (this.active && this.config) {
      // Keep status subtle; only refresh detail occasionally via debug
      if (event === 'play') {
        this.onStatus('filtering_active', this.config.title);
      }
    }
  }
}
