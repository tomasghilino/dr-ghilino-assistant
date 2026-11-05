import { z } from "zod";

/**
 * knowledge/sources.json: the allowlist of what the assistant may learn from. Adding a document
 * means adding an entry here and running `pnpm cli ingest`; no code change, no deploy.
 */
export const sourceConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  url: z.url().refine((url) => url.startsWith("https://"), "sources must use https"),
  kind: z.enum(["html_page", "markdown"]),
  enabled: z.boolean().default(true),
  /** Lower = more authoritative. On overlap, the lower-priority copy is dropped. */
  priority: z.number().int().min(0).default(0),
  description: z.string().default(""),
  /** URL to cite instead of `url` when a chunk has no anchor of its own. */
  citeAs: z.url().optional(),
  html: z
    .object({
      root: z.string().optional(),
      exclude: z.array(z.string()).default([]),
      /** Build the structured clinic profile from this page's JSON-LD. */
      clinicProfile: z.boolean().default(false),
    })
    .optional(),
  markdown: z.object({ excludeHeadings: z.array(z.string()).default([]) }).optional(),
});

export const sourcesFileSchema = z
  .object({ version: z.literal(1), sources: z.array(sourceConfigSchema).min(1) })
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    const urls = new Set<string>();
    file.sources.forEach((source, index) => {
      if (ids.has(source.id))
        ctx.addIssue({ code: "custom", path: ["sources", index, "id"], message: "duplicate id" });
      if (urls.has(source.url))
        ctx.addIssue({ code: "custom", path: ["sources", index, "url"], message: "duplicate url" });
      ids.add(source.id);
      urls.add(source.url);
    });
    if (file.sources.filter((source) => source.enabled && source.html?.clinicProfile).length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["sources"],
        message: "only one source may build the clinic profile",
      });
    }
  });

export type SourceConfig = z.infer<typeof sourceConfigSchema>;
export type SourcesFile = z.infer<typeof sourcesFileSchema>;
