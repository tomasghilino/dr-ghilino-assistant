import { z } from "zod";
import { ANSWER_KINDS } from "../domain/types.ts";
import type { JsonObjectSchema } from "../llm/types.ts";

/** Buttons the widget can show. The server builds their links; the model only names them. */
export const ACTION_TYPES = ["whatsapp", "call", "email", "directions"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * The model's final answer (ADR 0006). Structured outputs make the API return exactly this
 * shape; zod checks it again, because a refusal or a cut-off answer may not follow the schema.
 */
export const finalAnswerSchema = z.object({
  answer: z.string().min(1).max(2_000),
  kind: z.enum(ANSWER_KINDS),
  source_ids: z.array(z.string().regex(/^S\d{1,3}$/)).max(10),
  actions: z.array(z.enum(ACTION_TYPES)).max(4),
});
export type FinalAnswer = z.infer<typeof finalAnswerSchema>;

/** The same contract as JSON schema, without the constraints structured outputs ignores. */
export const FINAL_ANSWER_JSON_SCHEMA: JsonObjectSchema = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description:
        "The reply to the visitor, in Argentine Spanish, plain text, no markdown, no URLs.",
    },
    kind: {
      type: "string",
      enum: [...ANSWER_KINDS],
      description: "What kind of reply this is (see the system prompt).",
    },
    source_ids: {
      type: "array",
      items: { type: "string" },
      description: 'Ids of the sources the answer relies on, e.g. ["S1", "S3"]. Empty if none.',
    },
    actions: {
      type: "array",
      items: { type: "string", enum: [...ACTION_TYPES] },
      description: "Contact buttons to show under the reply. Empty if none fits.",
    },
  },
  required: ["answer", "kind", "source_ids", "actions"],
  additionalProperties: false,
};

/** Parse the model's text into a final answer, or null if it is not one. */
export function parseFinalAnswer(text: string): FinalAnswer | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const result = finalAnswerSchema.safeParse(json);
  return result.success ? result.data : null;
}
