import type { PrepareAdventureRequest } from '../../shared/host-schema.js';

/** Provider is supplied by the application; the job runner never selects a model or performs network calls. */
export type AdventureGenerationInput = Pick<PrepareAdventureRequest, 'premise' | 'locale' | 'preferences'>;
export type AdventureRepairContext = { candidate: unknown; issues: string[] };
export interface AdventureGenerationProvider {
  generateAdventure(input: AdventureGenerationInput, repair?: AdventureRepairContext): Promise<unknown>;
}
