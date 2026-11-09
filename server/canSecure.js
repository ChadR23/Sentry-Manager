'use strict';

// Whether a CAN upload came over HTTPS. On the web port the usual rule
// (isSecure: an encrypted connection, or a trusted proxy's
// X-Forwarded-Proto). The CAN port (CAN_PORT) may be open to the internet,
// so there a forwarded "https" counts only from an address on the local
// network (a reverse proxy there, with TRUST_PROXY): from any other address
// it is a header anyone could send over plain HTTP.

const { ipPermitted } = require('./tls');

/**
 * @param {import('http').IncomingMessage} req
 * @param {{ canPort: number, isSecure: (req: any) => boolean, local?: (ip: string) => boolean }} o
 */
function canUploadSecure(req, { canPort, isSecure, local = ipPermitted }) {
  if (req.socket?.localPort !== canPort) return isSecure(req);
  if (req.socket?.encrypted) return true;
  const from = String(req.socket?.remoteAddress || '').replace(/^::ffff:/i, '');
  return Boolean(from) && local(from) && isSecure(req);
}

module.exports = { canUploadSecure };
