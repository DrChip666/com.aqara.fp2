'use strict';

const { EventEmitter } = require('events');
const { Fp2Client, Fp2Error } = require('./Fp2Client');

const POLL_INTERVAL = 5 * 60 * 1000;
const RECONNECT_MIN = 10 * 1000;
const RECONNECT_MAX = 5 * 60 * 1000;

/**
 * One shared HomeKit connection per FP2, used by the main device and all its
 * zone devices. Handles connecting, polling and reconnecting.
 *
 * Events:
 *  - 'connected'    (state)            connection is up; state = { zones, light }
 *  - 'disconnected' ()                 connection lost, a reconnect is scheduled
 *  - 'unpaired'     ()                 the FP2 no longer accepts our keys
 *  - 'zone'         ({ id, occupied }) a zone's presence changed
 *  - 'light'        (lux)              the light level changed
 */
class Fp2Hub extends EventEmitter {

  constructor({ id, app }) {
    super();
    this.setMaxListeners(200); // one set of listeners per device; an FP2 has up to 30 zones
    this.id = id;
    this.app = app;
    this.homey = app.homey;

    this.address = null;
    this.port = null;
    this.client = null;
    this.state = null;
    this.connecting = null;
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_MIN;
    this.destroyed = false;
  }

  get connected() {
    return Boolean(this.client && this.client.connected && this.state);
  }

  log(...args) {
    this.app.log(`[FP2 ${this.id}]`, ...args);
  }

  /** Latest address from discovery. Reconnects when it changed while connected. */
  setTarget(address, port) {
    if (!address) return;
    const changed = address !== this.address || port !== this.port;
    this.address = address;
    this.port = port;
    if (changed && this.client) {
      this.log('Address changed to', `${address}:${port}`);
      this.reconnect().catch(() => {});
    }
  }

  /** Resolves with the current state, connecting first if needed. Throws Fp2Error. */
  async ensureConnected() {
    if (this.connected) return this.state;
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * Read the zones from the FP2 again, e.g. after zones were added in the Aqara
   * app. If that fails, the normal reconnect takes over, so devices recover.
   */
  async refresh() {
    try {
      await this._closeClient();
      return await this.ensureConnected();
    } catch (err) {
      this._onLost();
      throw err;
    }
  }

  /** Drop the current connection and connect again, e.g. after new keys or a new address. */
  async reconnect() {
    await this._closeClient();
    return this.ensureConnected();
  }

  async _connect() {
    const pairingData = this.app.getKeys(this.id);
    if (!pairingData) throw new Fp2Error('not_paired');
    if (!this.address) throw new Fp2Error('not_found');

    this._clearTimers();
    await this._closeClient();

    const client = new Fp2Client({
      id: this.id,
      address: this.address,
      port: this.port,
      pairingData,
      log: (...args) => this.log(...args),
    });
    client.on('zone', (zone) => {
      if (this.state) {
        const known = this.state.zones.find((z) => z.id === zone.id);
        if (known) known.occupied = zone.occupied;
      }
      this.emit('zone', zone);
    });
    client.on('light', (lux) => {
      if (this.state) this.state.light = lux;
      this.emit('light', lux);
    });
    client.on('disconnect', () => this._onLost());

    const state = await client.connect(); // throws Fp2Error
    if (this.destroyed) {
      await client.close();
      throw new Fp2Error('unreachable');
    }

    this.client = client;
    this.state = state;
    this.reconnectDelay = RECONNECT_MIN;
    this.pollTimer = this.homey.setInterval(() => this._poll(), POLL_INTERVAL);
    this.log(`Connected, ${state.zones.length} zone(s):`, state.zones.map((z) => z.name).join(', '));
    this.emit('connected', state);
    return state;
  }

  async _poll() {
    try {
      await this.client.poll();
    } catch (err) {
      this.log('Poll failed, reconnecting');
      this._onLost();
    }
  }

  _onLost() {
    if (this.destroyed || this.reconnectTimer) return;
    this._clearTimers();
    this._closeClient().catch(() => {});
    this.emit('disconnected');

    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
    this.reconnectTimer = this.homey.setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected().catch((err) => {
        if (err.i18nKey === 'error.not_paired') {
          // Rejected keys will not fix themselves; wait for Repair.
          this.log('FP2 rejected the pairing keys');
          this.emit('unpaired');
          return;
        }
        this._onLost();
      });
    }, delay);
  }

  /**
   * Remove Homey's pairing from the FP2, so it can be added again without a reset.
   * Returns false when Homey had no keys, i.e. there was no pairing to remove.
   */
  async unpair() {
    const pairingData = this.app.getKeys(this.id);
    if (!pairingData) return false;
    const client = this.client || new Fp2Client({
      id: this.id, address: this.address, port: this.port, pairingData,
    });
    this.client = null;
    client.removeAllListeners();
    await client.unpair();
    return true;
  }

  _clearTimers() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    if (this.reconnectTimer) this.homey.clearTimeout(this.reconnectTimer);
    this.pollTimer = null;
    this.reconnectTimer = null;
  }

  async _closeClient() {
    const { client } = this;
    this.client = null;
    this.state = null;
    if (!client) return;
    client.removeAllListeners();
    await client.close();
  }

  async destroy() {
    this.destroyed = true;
    this._clearTimers();
    await this._closeClient();
    this.removeAllListeners();
  }

}

module.exports = Fp2Hub;
