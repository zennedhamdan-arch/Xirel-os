import 'server-only';

const safeCodes = new Set([
  'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'ECONNREFUSED', 'ECONNRESET',
  'ETIMEDOUT', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_DESTROYED', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', '28P01', '28000', '3D000', '42P01', '42501', '53300', '57P03',
]);

/** Drizzle can wrap the driver error; never log its message, query, parameters, or cause. */
export function safeDatabaseErrorCode(error: unknown) {
  const queue = [error];
  for (let i = 0; i < queue.length && i < 12; i++) {
    const item = queue[i];
    if (!item || typeof item !== 'object') continue;
    const { code, cause, errors } = item as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof code === 'string' && safeCodes.has(code)) return code;
    if (cause) queue.push(cause);
    if (Array.isArray(errors)) queue.push(...errors.slice(0, 4));
  }
  return 'UNKNOWN';
}
