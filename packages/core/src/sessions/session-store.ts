import type { ConversationTurn } from "../agent/agent.ts";
import type { SessionStore } from "../chat/service.ts";
import type { RpcClient } from "../db/rpc.ts";
import type { Channel } from "../domain/types.ts";

/**
 * Encrypted, expiring conversation memory in Postgres (ADR 0007).
 *
 * The turns (already redacted) are encrypted with AES-256-GCM before they leave the function. The
 * key lives in function secrets, never in the database, so a dump or a backup holds ciphertext.
 * The session id and channel are bound as additional authenticated data: a payload copied into
 * another row does not decrypt. A row that fails to decrypt (wrong key after a rotation, tampering)
 * is treated as no session: the visitor simply starts over.
 */
export class SessionCipher {
  private constructor(private readonly key: CryptoKey) {}

  static async fromBase64(keyBase64: string): Promise<SessionCipher> {
    const raw = Uint8Array.from(atob(keyBase64), (char) => char.charCodeAt(0));
    if (raw.length !== 32) throw new Error("SESSION_ENCRYPTION_KEY must be 32 bytes");
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
    return new SessionCipher(key);
  }

  async encrypt(plaintext: string, associatedData: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(associatedData) },
        this.key,
        encoder.encode(plaintext),
      ),
    );
    const payload = new Uint8Array(iv.length + ciphertext.length);
    payload.set(iv, 0);
    payload.set(ciphertext, iv.length);
    return `v1.${toBase64(payload)}`;
  }

  async decrypt(payload: string, associatedData: string): Promise<string | null> {
    if (!payload.startsWith("v1.")) return null;
    try {
      const bytes = fromBase64(payload.slice(3));
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: encoder.encode(associatedData) },
        this.key,
        bytes.slice(12),
      );
      return decoder.decode(plaintext);
    } catch {
      return null;
    }
  }
}

export class SqlSessionStore implements SessionStore {
  constructor(
    private readonly rpc: RpcClient,
    private readonly cipher: SessionCipher,
    private readonly ttlSeconds: number,
  ) {}

  async load(conversationId: string): Promise<ConversationTurn[] | null> {
    if (!UUID.test(conversationId)) return null;
    const row = await this.rpc.value<{ payload: string; channel: string } | null>("session_get", {
      p_id: conversationId,
    });
    if (!row) return null;
    const json = await this.cipher.decrypt(row.payload, `${conversationId}:${row.channel}`);
    if (json === null) return null;
    try {
      const parsed = JSON.parse(json) as { turns?: unknown };
      return Array.isArray(parsed.turns) ? parsed.turns.filter(isTurn) : null;
    } catch {
      return null;
    }
  }

  async save(conversationId: string, channel: Channel, turns: ConversationTurn[]): Promise<void> {
    const payload = await this.cipher.encrypt(
      JSON.stringify({ turns }),
      `${conversationId}:${channel}`,
    );
    await this.rpc.value("session_put", {
      p_id: conversationId,
      p_channel: channel,
      p_payload: payload,
      p_turn_count: turns.filter((turn) => turn.role === "visitor").length,
      p_ttl_seconds: this.ttlSeconds,
    });
  }

  async delete(conversationId: string): Promise<void> {
    if (!UUID.test(conversationId)) return;
    await this.rpc.value("session_delete", { p_id: conversationId });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isTurn(value: unknown): value is ConversationTurn {
  if (typeof value !== "object" || value === null) return false;
  const turn = value as Record<string, unknown>;
  return (turn.role === "visitor" || turn.role === "assistant") && typeof turn.text === "string";
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}
