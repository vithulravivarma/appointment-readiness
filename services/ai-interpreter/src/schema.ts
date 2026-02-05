import { z } from 'zod';

// We strictly match what is already in your repository.ts
export const CheckCategoryEnum = z.enum([
  'ACCESS_CODE', 
  'SAFETY_ASSESSMENT', 
  'CAREGIVER_CONFIRMATION'
]);

export const CheckStatusEnum = z.enum(['PASS', 'FAIL', 'PENDING']);

export const ReadinessAnalysisSchema = z.object({
  updates: z.array(z.object({
    category: CheckCategoryEnum,
    status: CheckStatusEnum,
    confidence: z.number(),
    reasoning: z.string()
  })),
  summary: z.string()
});