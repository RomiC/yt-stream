export type ProcessState = 'running' | 'stopped';
export type IcecastAvailability = 'available' | 'unavailable';
export type MountState = 'streaming' | 'stopped';
export type StreamPhase = 'idle' | 'starting' | 'streaming' | 'stopped';
export type Health = 'ok' | 'failure';

export interface IcecastProbe {
  icecastReachable: boolean;
  mountpointActive: boolean;
  listeners: number;
}

export interface ProcessStatus {
  status: ProcessState;
}

export interface IcecastStatus {
  status: IcecastAvailability;
  state: MountState;
  listeners: number;
}

export interface GeneralStatus {
  state: StreamPhase;
  url: string | null;
}

export interface StreamStatus {
  streamlink: ProcessStatus;
  ffmpeg: ProcessStatus;
  icecast: IcecastStatus;
  general: GeneralStatus;
}

export interface HealthStatus extends StreamStatus {
  general: GeneralStatus & { health: Health };
}
