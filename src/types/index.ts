export type FilterAction = 'mute' | 'skip';
export type TitleKind = 'movie' | 'show';

export interface FilterInterval {
  id: string;
  start: number;
  end: number;
  action: FilterAction;
  label?: string;
}

export interface TitleFilterConfig {
  titleId: string;
  title: string;
  kind?: TitleKind;
  episodeName?: string;
  /** Amazon Prime GTI (amzn1.dv.gti.…); preferred match key */
  gti?: string;
  provider: 'prime-video';
  videoUrl?: string;
  matchPatterns: string[];
  filters: FilterInterval[];
}

export interface CreateTitleRequest {
  title: string;
  kind: TitleKind;
  episodeName?: string;
  /** Required Amazon GTI (amzn1.dv.gti.…) */
  gti: string;
  videoUrl: string;
  provider?: 'prime-video';
  matchPatterns?: string[];
}

export interface PublishTitleRequest {
  title?: string;
  kind?: TitleKind;
  episodeName?: string;
  gti?: string;
  videoUrl?: string;
  matchPatterns?: string[];
  filters: FilterInterval[];
}

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  message?: string;
}

export interface ApiErrorResponse {
  success: false;
  message: string;
  errors?: string[];
}

export type ExtensionStatus =
  | 'initialized'
  | 'video_detected'
  | 'filters_loaded'
  | 'filtering_active'
  | 'backend_failed'
  | 'title_not_matched'
  | 'awaiting_selection'
  | 'idle';

export interface PlaybackSnapshot {
  currentTime: number;
  paused: boolean;
  seeking: boolean;
  playbackRate: number;
  readyState: number;
  ended: boolean;
  waiting: boolean;
  /** An ad break is playing; filters must not act */
  adPlaying: boolean;
}

export type StatusListener = (status: ExtensionStatus, detail?: string) => void;
