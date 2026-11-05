import { z } from "zod";

export const RETRIEVAL_CASE_CATEGORIES = [
  "direct",
  "multi_chunk",
  "ambiguous",
  "misleading",
  "no_answer",
  "medical",
  "injection",
  "out_of_scope",
] as const;
export type RetrievalCaseCategory = (typeof RETRIEVAL_CASE_CATEGORIES)[number];

/** What the confidence gate should do. `any` leaves the decision to the safety layer (Phase 4). */
export type GateExpectation = "answer" | "abstain" | "any";

const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.enum(RETRIEVAL_CASE_CATEGORIES),
  query: z.string().min(1).max(800),
  expect: z.enum(["answer", "abstain", "any"]),
  /** Requirement groups of aliases. A group is met when any one of its chunks is retrieved. */
  relevant: z.array(z.array(z.string()).min(1)).default([]),
  note: z.string().optional(),
});

export const retrievalEvalFileSchema = z
  .object({
    version: z.literal(1),
    description: z.string(),
    /** Short name → heading path joined with " › " (the first line of every chunk). */
    aliases: z.record(z.string(), z.string().min(1)),
    cases: z.array(caseSchema).min(1),
  })
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    file.cases.forEach((item, index) => {
      if (ids.has(item.id))
        ctx.addIssue({ code: "custom", path: ["cases", index, "id"], message: "duplicate id" });
      ids.add(item.id);
      if (item.expect === "answer" && item.relevant.length === 0)
        ctx.addIssue({
          code: "custom",
          path: ["cases", index, "relevant"],
          message: "an answerable case needs at least one relevant group",
        });
      if (item.expect === "abstain" && item.relevant.length > 0)
        ctx.addIssue({
          code: "custom",
          path: ["cases", index, "relevant"],
          message: "a case that should abstain has nothing relevant to retrieve",
        });
      for (const alias of item.relevant.flat())
        if (!(alias in file.aliases))
          ctx.addIssue({
            code: "custom",
            path: ["cases", index, "relevant"],
            message: `unknown alias ${alias}`,
          });
    });
  });

export type RetrievalEvalFile = z.infer<typeof retrievalEvalFileSchema>;
export type RetrievalCase = RetrievalEvalFile["cases"][number];

/** The key a chunk is identified by in the evaluation: its heading path. */
export function chunkKey(headingPath: readonly string[]): string {
  return headingPath.join(" › ");
}

/** Replace aliases with chunk keys. */
export function resolveGroups(file: RetrievalEvalFile, item: RetrievalCase): string[][] {
  return item.relevant.map((group) => group.map((alias) => file.aliases[alias] as string));
}
