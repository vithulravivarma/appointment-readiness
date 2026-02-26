import { IngestionPayload } from '../repository';

export interface IngestionBatchResult {
  appointments: IngestionPayload[];
  metadata: Record<string, string | number | boolean>;
}

export interface IngestionSource {
  load(): Promise<IngestionBatchResult>;
}
