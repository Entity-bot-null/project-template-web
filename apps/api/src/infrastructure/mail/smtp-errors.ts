// What a failed delivery means for the message: try again later, give up, or
// fix the configuration. The SMTP reply code decides first (RFC 5321: 4xx is
// transient, 5xx permanent), because nodemailer's own error code does not: it
// reports a "451 try later" and a "550 no such user" from RCPT TO alike, as
// EENVELOPE. Without a reply, nodemailer's code tells what failed on our side.

export interface DeliveryFailure {
  /** A short category for logs and the outbox: never the server's text, which can quote the address. */
  category: string;
  /** Retrying cannot help: the server refused this message for good. */
  permanent: boolean;
  /** The server refused our credentials or our TLS settings: every message fails until it is fixed. */
  configuration: boolean;
}

// Replies about authentication: a 5xx among them means our credentials, not
// this message, so the message waits for the fix instead of failing.
const AUTH_REPLY_CODES = new Set([454, 530, 534, 535, 538]);

export function classifyDeliveryError(error: unknown): DeliveryFailure {
  const { code, responseCode } = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    responseCode?: unknown;
  };
  if (
    typeof responseCode === 'number' &&
    Number.isInteger(responseCode) &&
    responseCode >= 400 &&
    responseCode < 600
  ) {
    const category = `smtp_${String(Math.floor(responseCode / 100))}xx_${String(responseCode)}`;
    if (code === 'EAUTH' || AUTH_REPLY_CODES.has(responseCode)) {
      return { category, permanent: false, configuration: true };
    }
    return { category, permanent: responseCode >= 500, configuration: false };
  }
  switch (code) {
    case 'EAUTH':
      return { category: 'auth', permanent: false, configuration: true };
    case 'ETLS':
      return { category: 'tls', permanent: false, configuration: true };
    case 'ETIMEDOUT':
      return { category: 'timeout', permanent: false, configuration: false };
    case 'EDNS':
      return { category: 'dns', permanent: false, configuration: false };
    case 'ECONNECTION':
    case 'ESOCKET':
    case 'ECONNREFUSED':
    case 'ECONNRESET':
      return { category: 'connection', permanent: false, configuration: false };
    // Refused before any server saw it: the address or the message itself.
    case 'EENVELOPE':
      return { category: 'invalid_address', permanent: true, configuration: false };
    case 'EMESSAGE':
      return { category: 'invalid_message', permanent: true, configuration: false };
    default:
      return { category: 'unknown', permanent: false, configuration: false };
  }
}
