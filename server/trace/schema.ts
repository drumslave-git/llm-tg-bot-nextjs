import { z } from "zod";

import { traceStatusSchema } from "@/lib/trace";

/**
 * Query schema for the Debug trace list and bundle-export endpoints. Coerces the
 * string search params into typed filters. Shared by the `app/api/traces/**`
 * Route Handlers and the Server Component Debug pages so both parse identically.
 */
export const traceQuerySchema = z.object({
  feature: z.string().min(1).optional(),
  status: traceStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type TraceQueryInput = z.infer<typeof traceQuerySchema>;
