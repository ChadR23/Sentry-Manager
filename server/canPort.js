'use strict';

// The device port (CAN_PORT, 10000): the CAN Bridge's uploads and the Sentry
// USB management link. Open while CAN uploads are on or a Sentry USB is
// paired or pairing, closed otherwise.
//
// Opening waits for the certificate, so two calls can overlap. They are run
// one at a time, in the order they were made: however quickly the uploads are
// turned on and off, the port ends as the last call said, with one listener
// when on and none when off.

/**
 * @param {object} o
 * @param {number} o.port
 * @param {string} o.host
 * @param {() => Promise<import('net').Server>} o.make  a new server, not listening yet
 * @param {{ info: Function, warn: Function }} o.log
 * @param {string} [o.url]  the upload address, for the log
 */
function createCanPort({ port, host, make, log, url = '' }) {
  let server = null;
  let state = { listening: false, error: null, port };
  let queue = Promise.resolve();

  const failed = (err) => {
    state = { listening: false, error: err.code === 'EADDRINUSE' ? `Port ${port} is used by something else.` : err.message, port };
    log.warn(`Device port ${port}: ${err.message}`);
  };

  // listens; the promise ends once it listens or could not
  const listen = (srv) => new Promise((resolve) => {
    const refused = (err) => {
      failed(err);
      if (server === srv) server = null;
      resolve();
    };
    srv.once('error', refused);
    srv.listen(port, host, () => {
      srv.off('error', refused);
      srv.on('error', failed); // later errors are only reported
      state = { listening: true, error: null, port };
      log.info(`Device port open: ${url || `port ${port}`}`);
      resolve();
    });
  });

  const open = async () => {
    if (server) return;
    let srv;
    try {
      srv = await make();
    } catch (err) {
      failed(err);
      throw err;
    }
    server = srv; // set before listening, so a certificate renewal reaches it
    await listen(srv);
  };

  const close = async () => {
    const srv = server;
    server = null;
    state = { listening: false, error: null, port };
    if (!srv) return;
    await new Promise((resolve) => {
      srv.close(() => resolve());
      srv.closeAllConnections?.();
    });
    log.info(`Device port ${port} closed`);
  };

  /** Opens (true) or closes (false) the port, after every earlier call. */
  const set = (on) => {
    const run = queue.then(() => (on ? open() : close()));
    queue = run.catch(() => {});
    return run;
  };

  return { set, server: () => server, state: () => state };
}

module.exports = { createCanPort };
