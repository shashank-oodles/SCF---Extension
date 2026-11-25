import type { ExtensionStatus } from './index';
import type { PrimeKind } from '../services/primeTitleExtractor';

export interface SidePanelEpisode {
  name: string;
  label?: string;
  titleId?: string;
  nowPlaying?: boolean;
}

/** What the side panel displays — extracted from Prime, not backend matching. */
export interface SidePanelState {
  playerOpen: boolean;
  sidePanelOpen?: boolean;
  status: ExtensionStatus;
  statusDetail?: string;

  /** Extracted from the Prime page */
  detected?: {
    kind: PrimeKind;
    title: string;
    episodeName?: string;
    seasonLabel?: string;
    /** Playing title GTI from Sonar / playerChromeResources */
    gti?: string;
    parentGti?: string;
    pageUrl?: string;
    episodes: SidePanelEpisode[];
    sources: string[];
  } | null;

  selectedEpisode?: string | null;
  selectedGti?: string | null;

  /** Live title clock (seconds, ads excluded) when player is open */
  currentTime?: number | null;
  adPlaying?: boolean;

  /** Saved filters for the active title/episode (from backend) */
  savedFilters?: Array<{
    id: string;
    start: number;
    end: number;
    action: 'mute' | 'skip';
    label?: string;
  }> | null;

  updatedAt: number;
}
