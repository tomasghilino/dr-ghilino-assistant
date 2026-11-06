import type { SourceRef } from "../domain/types.ts";

/**
 * Citation ids for one visitor message. Every tool result that shows the model a piece of the
 * site registers it here and gets the next id (S1, S2, ...), so ids never collide across tool
 * calls in a turn. The model cites ids; the server turns them back into titles and URLs, so the
 * model never writes a link.
 */
export class SourceRegistry {
  private readonly sources = new Map<string, SourceRef>();

  register(title: string, url: string): string {
    const id = `S${this.sources.size + 1}`;
    this.sources.set(id, { id, title, url });
    return id;
  }

  get(id: string): SourceRef | undefined {
    return this.sources.get(id);
  }

  get size(): number {
    return this.sources.size;
  }

  /** The cited sources, in citation order, one entry per URL (the visitor sees links, not ids). */
  resolve(ids: readonly string[]): { sources: SourceRef[]; unknown: string[] } {
    const sources: SourceRef[] = [];
    const unknown: string[] = [];
    const urls = new Set<string>();
    for (const id of ids) {
      const source = this.sources.get(id);
      if (!source) {
        unknown.push(id);
        continue;
      }
      if (urls.has(source.url)) continue;
      urls.add(source.url);
      sources.push(source);
    }
    return { sources, unknown };
  }
}
