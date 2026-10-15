import { z } from "zod";

/**
 * A saved sign-in as kept in the keychain or the fallback file. Every record read back is
 * validated against this schema, so an unknown key or an empty secret is rejected.
 */
export const StoredCredentialSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("api-key"),
    apiKey: z.string().min(1),
    accountId: z.string().min(1).optional(),
    baseURL: z.url().optional(),
    /**
     * The AWS region, which fills `{region}` in a provider address (Claude Platform on AWS).
     * The pattern matters because the value goes into a hostname.
     */
    region: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    /**
     * The workspace the key is scoped to, for providers that name it on every request
     * (Claude Platform on AWS sends it as `anthropic-workspace-id`).
     */
    workspaceId: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("oauth"),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
    /** Epoch milliseconds. */
    expiresAt: z.number().int().nonnegative(),
    accountId: z.string().min(1).optional(),
    /** Needed to renew the token. */
    clientId: z.string().min(1).optional(),
  }),
]);
export type StoredCredential = z.infer<typeof StoredCredentialSchema>;

/** What may be shown to a user: never a key or a token. */
export const CredentialSummarySchema = z.strictObject({
  providerId: z.string().min(1),
  kind: z.enum(["api-key", "oauth"]),
  accountId: z.string().min(1).optional(),
  /** The AWS region of a saved key sign-in. Not a secret. */
  region: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  /** The workspace a saved key sign-in is scoped to. Not a secret. */
  workspaceId: z.string().min(1).optional(),
  expiresAt: z.number().int().nonnegative().optional(),
});
export type CredentialSummary = z.infer<typeof CredentialSummarySchema>;
