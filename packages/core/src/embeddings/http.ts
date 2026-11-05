import { AppError } from "../lib/errors.ts";

export interface JsonRequest {
  fetch: typeof fetch;
  url: string;
  apiKey: string;
  body: unknown;
  timeoutMs: number;
  maxRetries: number;
  /** Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

/**
 * POST JSON with a per-attempt timeout and exponential backoff on transient failures
 * (rate limits, 5xx, network errors). Errors carry the HTTP status only: provider error bodies can
 * echo the input, and the input may be a visitor's question.
 */
export async function postJson(request: JsonRequest): Promise<unknown> {
  const sleep = request.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await request.fetch(request.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${request.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      if (attempt < request.maxRetries) {
        await sleep(backoff(attempt));
        continue;
      }
      throw new AppError(
        timedOut ? "timeout" : "upstream_embeddings",
        "El servicio de búsqueda no responde.",
        {
          cause: error,
          retryable: true,
          internalMessage: timedOut ? "embeddings request timed out" : "embeddings network error",
        },
      );
    }

    if (response.ok) return response.json();

    await response.body?.cancel();
    if (RETRYABLE.has(response.status) && attempt < request.maxRetries) {
      await sleep(retryAfterMs(response) ?? backoff(attempt));
      continue;
    }
    throw new AppError("upstream_embeddings", "El servicio de búsqueda no está disponible.", {
      retryable: RETRYABLE.has(response.status),
      internalMessage: `embeddings provider returned HTTP ${response.status}`,
    });
  }
}

/** 0.5 s, 1 s, 2 s, 4 s ... with up to 25% jitter so parallel retries do not align. */
function backoff(attempt: number): number {
  const base = 500 * 2 ** attempt;
  return Math.round(base + Math.random() * base * 0.25);
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.min(Math.max(0, date - Date.now()), 30_000);
}
