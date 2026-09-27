import type { SourceId } from '@hf/shared';
import type { SourceAdapter } from './types.js';
import { unstopAdapter } from './unstop.js';
import { devpostAdapter } from './devpost.js';
import { mlhAdapter } from './mlh.js';
import { hackerEarthAdapter } from './hackerearth.js';
import { organizerWebsiteAdapter } from './organizer-website.js';

export const ADAPTERS: SourceAdapter[] = [
  unstopAdapter,
  devpostAdapter,
  mlhAdapter,
  hackerEarthAdapter,
  organizerWebsiteAdapter,
];

export const ADAPTERS_BY_ID: Record<SourceId, SourceAdapter> = ADAPTERS.reduce(
  (acc, adapter) => {
    acc[adapter.id] = adapter;
    return acc;
  },
  {} as Record<SourceId, SourceAdapter>,
);

export function enabledAdapters(): SourceAdapter[] {
  return ADAPTERS.filter((a) => a.enabled);
}

export function getAdapter(id: SourceId): SourceAdapter | undefined {
  return ADAPTERS_BY_ID[id];
}

export * from './types.js';
