import type { ConfigEnv } from './config';

export interface ReleaseMetadata {
  version: string;
  commit: string;
}

export function getReleaseMetadata(env: ConfigEnv = process.env): ReleaseMetadata {
  return {
    version: env.APP_VERSION || 'dev',
    commit: env.APP_COMMIT || 'unknown'
  };
}
