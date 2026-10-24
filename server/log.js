'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');
const { EventEmitter } = require('events');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
// the real console, before captureConsole() routes it through a logger
const CONSOLE = { log: console.log.bind(console), error: console.error.bind(console) };

// Anything that looks like a secret in a line is masked before it is kept or
// shown (mount options, URLs with credentials).
const SECRET = /\b(pass(?:word)?|pwd|secret|token|cookie|authorization)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi;

function redact(text) {
  return String(text).replace(SECRET, '$1$2***').replace(URL_CREDENTIALS, '$1***@');
}

/**
 * Console logger that also keeps the last lines for the web UI and, with
 * `file`, writes every line to that file in the data folder (one previous
 * file is kept when it grows past `maxBytes`), so problems can be read and
 * downloaded in the Overview's Logs without a shell on the server.
 */
class Logger extends EventEmitter {
  constructor({ level = 'info', keep = 1000, silent = false, file = null, maxBytes = 5 * 1024 * 1024 } = {}) {
    super();
    this.min = LEVELS[level] || LEVELS.info;
    this.keep = keep;
    this.silent = silent;
    this.lines = [];
    this.file = file;
    this.maxBytes = maxBytes;
    this.fileBytes = 0;
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.fileBytes = fs.statSync(file).size;
      } catch {
        this.fileBytes = 0;
      }
      this.loadTail();
    }
  }

  // After a restart (or a crash) the Overview's Logs still show what happened
  // before it: the end of the file is read back in.
  loadTail(bytes = 256 * 1024) {
    let text = '';
    try {
      const fd = fs.openSync(this.file, 'r');
      try {
        const start = Math.max(0, this.fileBytes - bytes);
        const buf = Buffer.alloc(this.fileBytes - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    const LINE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (DEBUG|INFO|WARN|ERROR)\s* \[([^\]]{1,40})\] (.*)$/;
    for (const raw of text.split('\n')) {
      const m = LINE.exec(raw);
      if (m) this.lines.push({ at: Date.parse(m[1]), level: m[2].toLowerCase(), scope: m[3], message: m[4] });
    }
    if (this.lines.length > this.keep) this.lines.splice(0, this.lines.length - this.keep);
  }

  // echo: false keeps the line out of the console (it is already there, e.g.
  // printed by the supervisor)
  write(level, scope, message, { echo = true } = {}) {
    if (LEVELS[level] < this.min) return;
    const entry = { at: Date.now(), level, scope, message: redact(message) };
    this.lines.push(entry);
    if (this.lines.length > this.keep) this.lines.splice(0, this.lines.length - this.keep);
    const line = `${new Date(entry.at).toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${entry.message}`;
    if (!this.silent && echo) (level === 'error' || level === 'warn' ? CONSOLE.error : CONSOLE.log)(line);
    this.append(line);
    this.emit('line', entry);
  }

  // Written straight away (not buffered), so the last lines before a crash
  // are in the file too.
  append(line) {
    if (!this.file) return;
    try {
      const data = `${line}\n`;
      if (this.fileBytes + data.length > this.maxBytes) {
        fs.renameSync(this.file, `${this.file}.1`);
        this.fileBytes = 0;
      }
      fs.appendFileSync(this.file, data, { mode: 0o600 });
      this.fileBytes += Buffer.byteLength(data);
    } catch {
      // a full or read-only data folder must not stop the app; the console still has it
    }
  }

  scope(name) {
    return {
      debug: (m) => this.write('debug', name, m),
      info: (m) => this.write('info', name, m),
      warn: (m) => this.write('warn', name, m),
      error: (m) => this.write('error', name, m)
    };
  }

  /**
   * Everything else in the process that prints (the converter, libraries,
   * crashes) goes through here too: "[CONVERTER] text" becomes scope
   * "converter".
   */
  captureConsole() {
    const take = (level) => (...args) => {
      const text = util.format(...args);
      // Node's own notices ("(node:12) SomeWarning: ...") are warnings
      if (/^\(node:\d+\) \w*Warning:/.test(text)) return this.write('warn', 'node', text.replace(/^\(node:\d+\) /, ''));
      const m = /^\[([A-Za-z][\w-]{0,31})\]\s*/.exec(text);
      this.write(level, m ? m[1].toLowerCase() : 'app', m ? text.slice(m[0].length) : text);
    };
    console.log = take('info');
    console.info = take('info');
    console.warn = take('warn');
    console.error = take('error');
    process.on('uncaughtExceptionMonitor', (err, origin) => {
      this.write('error', 'crash', `${origin}: ${err?.stack || err}`);
    });
  }

  recent(limit = 100, { minLevel = 'debug' } = {}) {
    const min = LEVELS[minLevel] || 0;
    return this.lines.filter((entry) => LEVELS[entry.level] >= min).slice(-limit);
  }

  /** The kept file(s), oldest first, for download. */
  fileText() {
    if (!this.file) return '';
    return [`${this.file}.1`, this.file].map((f) => {
      try {
        return fs.readFileSync(f, 'utf8');
      } catch {
        return '';
      }
    }).join('');
  }
}

module.exports = { Logger, redact, LEVELS };
