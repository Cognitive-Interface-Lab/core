import { createHash, randomBytes } from "node:crypto";

/** A PKCE pair: the challenge is sent first, the verifier proves later that the same client came back. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** An unguessable value that ties a sign-in reply to the request that started it. */
export function randomState(): string {
  return randomBytes(32).toString("base64url");
}
