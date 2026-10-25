'use strict';

const SETTING_KEY = 'diagLog';
const CLEAR_KEY = 'diagLogClearRequest';
const MAX_LINES = 300;
const SAVE_DELAY_MS = 2000;

/**
 * Small ring buffer that the user can read on the app settings page.
 * Never log the HomeKit setup code or pairing keys here.
 */
class DiagLog {

  constructor(homey, { log = () => {}, maxLines = MAX_LINES } = {}) {
    this.homey = homey;
    this.log = log;
    this.maxLines = maxLines;
    this.saveTimer = null;

    const stored = homey.settings.get(SETTING_KEY);
    this.lines = Array.isArray(stored) ? stored : [];

    // The settings page asks for a clear by writing a timestamp to CLEAR_KEY.
    homey.settings.on('set', (key) => {
      if (key === CLEAR_KEY) this.clear();
    });
  }

  add(area, message, details) {
    const extra = details ? ` ${DiagLog.format(details)}` : '';
    const line = `${new Date().toISOString()} [${area}] ${message}${extra}`;

    this.lines.push(line);
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
    this.log(line);
    this.scheduleSave();
  }

  error(area, message, err, details = {}) {
    this.add(area, message, { ...details, ...DiagLog.describeError(err) });
  }

  header() {
    this.add('app', 'Started', {
      app: this.homey.manifest.version,
      homey: this.homey.version,
    });
  }

  clear() {
    this.lines = [];
    this.add('app', 'Log cleared by user');
    this.save();
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = this.homey.setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DELAY_MS);
  }

  save() {
    try {
      this.homey.settings.set(SETTING_KEY, this.lines);
    } catch (err) {
      this.log(`DiagLog save failed: ${err.message}`);
    }
  }

  // Pulls out the fields that tell network, port and protocol problems apart:
  // ECONNREFUSED = nothing listens on that port (stale port, HAP server down)
  // ETIMEDOUT / EHOSTUNREACH = packets do not arrive (isolation, VLAN, Wi-Fi)
  // statusCode = HAP TLV error from the FP2 (6 = already paired)
  static describeError(err) {
    if (!err) return {};
    return {
      error: err.name,
      code: err.code,
      statusCode: err.statusCode,
      syscall: err.syscall,
      address: err.address,
      port: err.port,
      message: err.message,
    };
  }

  static format(details) {
    return Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
      .join(' ');
  }

}

module.exports = DiagLog;
