import { parseArgs } from "node:util";

const USAGE = `Usage: pnpm cli smoke --url <api base> --origin <allowed origin> [--no-model]

  Checks a running API from the outside, the way the widget uses it: health, the widget script,
  the widget texts, CORS for an allowed and a foreign origin, the emergency fast path, one real
  question and its follow-up (two model calls, well under one US cent), and DELETE.
  --no-model skips the two questions that call the model.

  Examples:
    pnpm cli smoke --url http://localhost:8787 --origin http://localhost:5173
    pnpm cli smoke --url "https://c94k6z7z.us-east.insforge.app/functions/chat-api?path=/" \\
                   --origin https://drluisghilino.com.ar`;

interface ChatReply {
  conversationId?: string;
  answer?: string;
  kind?: string;
  sources?: Array<{ title: string; url: string }>;
}

/**
 * Post-deploy smoke test (DEPLOYMENT.md). Needs no keys: it only talks to the public API, so it
 * proves what a visitor's browser would see. Prints one line per check; exit code 1 if any fails.
 */
export async function smokeCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      origin: { type: "string" },
      "no-model": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.url || !values.origin) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const baseUrl = values.url;
  // Same rule as the widget: a base with a query string (InsForge: "…/functions/chat-api?path=/")
  // gets the route in `path`; otherwise the route is appended to the URL path.
  const at = (route: string) => {
    const url = new URL(baseUrl);
    if (url.search) {
      url.searchParams.set("path", route);
      return url.toString();
    }
    return `${baseUrl.replace(/\/+$/, "")}${route}`;
  };
  const origin = values.origin;
  let failures = 0;
  const check = async (name: string, run: () => Promise<string>) => {
    const started = performance.now();
    try {
      const detail = await run();
      console.log(`✓ ${name} (${Math.round(performance.now() - started)} ms) ${detail}`);
    } catch (error) {
      failures += 1;
      console.log(`✗ ${name}: ${(error as Error).message}`);
    }
  };
  const chat = (body: unknown, from = origin) =>
    fetch(at(`/v1/chat`), {
      method: "POST",
      headers: { Origin: from, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const expectStatus = (response: Response, status: number) => {
    if (response.status !== status) throw new Error(`HTTP ${response.status}, expected ${status}`);
  };

  await check("health", async () => {
    const response = await fetch(at(`/health`));
    expectStatus(response, 200);
    const body = (await response.json()) as { status?: string; version?: string };
    if (body.status !== "ok") throw new Error(`status ${body.status}`);
    return `version ${body.version}`;
  });

  await check("widget script", async () => {
    const response = await fetch(at(`/widget.js`));
    expectStatus(response, 200);
    const type = response.headers.get("Content-Type") ?? "";
    if (!type.startsWith("text/javascript")) throw new Error(`Content-Type ${type}`);
    const size = (await response.text()).length;
    if (size < 5_000) throw new Error(`only ${size} bytes`);
    return `${(size / 1024).toFixed(1)} KiB`;
  });

  await check("widget texts, readable from the site", async () => {
    const response = await fetch(at(`/v1/config`), { headers: { Origin: origin } });
    expectStatus(response, 200);
    const allowed = response.headers.get("Access-Control-Allow-Origin");
    // InsForge's gateway owns CORS on functions and answers "*" (the widget sends no
    // credentials, so browsers accept it); our own server answers with the origin.
    if (allowed !== origin && allowed !== "*") {
      throw new Error(`Access-Control-Allow-Origin ${allowed}`);
    }
    const body = (await response.json()) as { disclosure?: string };
    if (!body.disclosure) throw new Error("no AI disclosure text");
    return "";
  });

  await check("CORS preflight", async () => {
    const response = await fetch(at(`/v1/chat`), {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    if (response.status !== 204 && response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (response.headers.get("Access-Control-Allow-Origin") !== origin) {
      throw new Error("origin not allowed");
    }
    return "";
  });

  await check("a foreign origin is refused before any model call", async () => {
    const response = await chat({ message: "hola" }, "https://example.com");
    expectStatus(response, 403);
    return "";
  });

  await check("emergency fast path", async () => {
    const response = await chat({ message: "no puedo respirar" });
    expectStatus(response, 200);
    const body = (await response.json()) as ChatReply;
    if (body.kind !== "emergency") throw new Error(`kind ${body.kind}`);
    if (!/107|911/.test(body.answer ?? "")) throw new Error("no emergency number in the answer");
    return "";
  });

  if (!values["no-model"]) {
    let conversationId: string | undefined;
    await check("a real question", async () => {
      const response = await chat({ message: "¿Dónde atiende el doctor?" });
      expectStatus(response, 200);
      const body = (await response.json()) as ChatReply;
      if (body.kind !== "answered") throw new Error(`kind ${body.kind}`);
      if (!/San Miguel|Boulogne/.test(body.answer ?? "")) throw new Error("no office named");
      if ((body.sources ?? []).length === 0) throw new Error("no sources");
      conversationId = body.conversationId;
      return `${body.sources?.length} sources`;
    });

    await check("the follow-up continues the conversation", async () => {
      if (!conversationId) throw new Error("no conversation id from the previous check");
      const response = await chat({ conversationId, message: "¿y los sábados?" });
      expectStatus(response, 200);
      const body = (await response.json()) as ChatReply;
      if (body.conversationId !== conversationId) throw new Error("a new conversation started");
      if (!/10/.test(body.answer ?? "")) throw new Error("no Saturday hours in the answer");
      return "";
    });

    await check("DELETE forgets the conversation", async () => {
      if (!conversationId) throw new Error("no conversation id");
      const response = await fetch(at(`/v1/chat/${conversationId}`), {
        method: "DELETE",
        headers: { Origin: origin },
      });
      expectStatus(response, 204);
      return "";
    });
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  return failures === 0 ? 0 : 1;
}
