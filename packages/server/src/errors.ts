import { CoreError, type ErrorCode } from "@core/contracts";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  auth: 401,
  not_found: 404,
  conflict: 409,
  content_filter: 422,
  rate_limit: 429,
  aborted: 499,
  unknown: 500,
  unavailable: 503,
  timeout: 504,
};

export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** HTTP status for an error code. */
export function httpStatus(code: ErrorCode): number {
  return STATUS[code];
}

/** A CoreError that answers with a specific HTTP status instead of `httpStatus(code)`. */
export class HttpError extends CoreError {
  readonly status: number;

  constructor(code: ErrorCode, message: string, status: number) {
    super(code, message);
    this.status = status;
  }
}

/**
 * What `readBody` needs from a schema: zod's `safeParse`, described structurally so the server
 * does not depend on zod.
 */
export type BodySchema<T> = {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }> } };
};

/** A JSON answer; `no-store` keeps it out of caches. */
export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const out = new Headers(headers);
  out.set("content-type", "application/json; charset=utf-8");
  out.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: out });
}

/**
 * The `ApiErrorBody` answer for any thrown value. Only a CoreError's shape is sent; anything else
 * becomes a generic 500, so the original message and stack never reach the client.
 */
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonResponse({ ok: false, error: error.toJSON() }, error.status);
  }
  if (CoreError.is(error)) {
    return jsonResponse({ ok: false, error: error.toJSON() }, httpStatus(error.code));
  }
  return jsonResponse(
    { ok: false, error: { code: "unknown", message: "internal error", retryable: false } },
    500,
  );
}

/**
 * Reads and checks a JSON request body. Only `application/json` is accepted, which also keeps
 * cross-site form posts out. The size limit applies to the declared length and to the bytes
 * actually read. Errors name the failing paths of the schema, never its messages or any value.
 */
export async function readBody<T>(
  request: Request,
  schema: BodySchema<T>,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<T> {
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpError("bad_request", "content type must be application/json", 415);
  }

  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBodyBytes) throw tooLarge(maxBodyBytes);

  const bytes = await readBytes(request, maxBodyBytes);

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CoreError("bad_request", "invalid JSON");
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    throw new CoreError("bad_request", `invalid body: ${issuePaths(result.error.issues)}`);
  }
  return result.data;
}

function tooLarge(maxBodyBytes: number): HttpError {
  return new HttpError("bad_request", `body is larger than ${maxBodyBytes} bytes`, 413);
}

/** Reads the whole body, stopping as soon as it passes the limit. A null body is empty. */
async function readBytes(request: Request, maxBodyBytes: number): Promise<Uint8Array> {
  if (request.body === null) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBodyBytes) {
      await reader.cancel();
      throw tooLarge(maxBodyBytes);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The unique issue paths, each segment joined with ".", the root shown as "(root)". */
function issuePaths(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>): string {
  const paths = new Set<string>();
  for (const issue of issues) {
    paths.add(issue.path.length === 0 ? "(root)" : issue.path.map((segment) => String(segment)).join("."));
  }
  return [...paths].join(", ");
}
