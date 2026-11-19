import type { ExtensionStatus, FilterInterval } from './index';

export interface SidePanelCandidate {
  titleId: string;
  title: string;
  kind?: string;
  episodeName?: string;
  filterCount: number;
  filters: FilterInterval[];
}

export interface SidePanelState {
  playerOpen: boolean;
  /** True while the SCF Chrome side panel page is connected */
  sidePanelOpen?: boolean;
  status: ExtensionStatus;
  statusDetail?: string;
  seriesLabel?: string | null;
  seriesKey?: string | null;
  reasons?: string[];
  candidates: SidePanelCandidate[];
  selectedId?: string | null;
  updatedAt: number;
}
