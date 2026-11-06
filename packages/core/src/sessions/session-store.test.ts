import { describe, expect, it } from "vitest";
import { SessionCipher } from "./session-store.ts";

const KEY = btoa("k".repeat(32));

describe("SessionCipher (AES-256-GCM)", () => {
  it("round-trips, with a fresh IV every time", async () => {
    const cipher = await SessionCipher.fromBase64(KEY);
    const a = await cipher.encrypt("hola", "id:web");
    const b = await cipher.encrypt("hola", "id:web");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(await cipher.decrypt(a, "id:web")).toBe("hola");
  });

  it("refuses ciphertext moved to another session, tampered, or from another key", async () => {
    const cipher = await SessionCipher.fromBase64(KEY);
    const payload = await cipher.encrypt("hola", "id-1:web");
    expect(await cipher.decrypt(payload, "id-2:web")).toBeNull();
    const tampered = `${payload.slice(0, -4)}AAAA`;
    expect(await cipher.decrypt(tampered, "id-1:web")).toBeNull();
    const other = await SessionCipher.fromBase64(btoa("z".repeat(32)));
    expect(await other.decrypt(payload, "id-1:web")).toBeNull();
    expect(await cipher.decrypt("plain text", "id-1:web")).toBeNull();
  });

  it("requires a 32-byte key", async () => {
    await expect(SessionCipher.fromBase64(btoa("short"))).rejects.toThrow(/32 bytes/);
  });
});
