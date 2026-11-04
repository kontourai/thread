import { z } from "zod";

/** A single source event, not a conversation turn or a paired tool call. */
export const ObservedToolEvent = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  ordinal: z.number().int().positive(),
  timestamp: z.string().min(1),
  session: z.string().min(1),
  projectId: z.string(),
  projectName: z.string(),
  event: z.enum(["tool_start", "tool_complete"]),
  tool: z.string(),
  input: z.string().optional(),
  output: z.string().optional(),
});
export type ObservedToolEvent = z.infer<typeof ObservedToolEvent>;
