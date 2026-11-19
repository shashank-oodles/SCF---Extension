export type FilterAction = 'mute' | 'skip';

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
  provider: 'prime-video';
  matchPatterns: string[];
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
  | 'idle';

export interface PlaybackSnapshot {
  currentTime: number;
  paused: boolean;
  seeking: boolean;
  playbackRate: number;
  readyState: number;
  ended: boolean;
  waiting: boolean;
}

export type StatusListener = (status: ExtensionStatus, detail?: string) => void;
