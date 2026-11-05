/**
 * The only way the core touches the database (ADR 0005). Every operation is a SQL function:
 * production calls it through the InsForge SDK (PostgREST `rpc`), tests call the very same
 * function on PGlite. Arguments are named, JSON-serialisable values.
 */
export type RpcArgs = Record<string, string | number | boolean | null | object>;

export interface RpcClient {
  /** Call a set-returning function and get its rows. */
  rows<T>(fn: string, args?: RpcArgs): Promise<T[]>;
  /** Call a function that returns a single value (scalar, json or void → null). */
  value<T>(fn: string, args?: RpcArgs): Promise<T>;
}

export class RpcError extends Error {
  readonly fn: string;
  constructor(fn: string, message: string, options?: { cause?: unknown }) {
    super(`rpc ${fn} failed: ${message}`, options);
    this.name = "RpcError";
    this.fn = fn;
  }
}

/** pgvector accepts the text form "[0.1,0.2,...]" for both PostgREST and direct SQL. */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}
