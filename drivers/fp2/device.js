'use strict';

const Homey = require('homey');
const { Fp2Client } = require('../../lib/Fp2Client');

const ZONE_PREFIX = 'alarm_motion.zone_';
const POLL_INTERVAL = 5 * 60 * 1000;
const RECONNECT_MIN = 10 * 1000;
const RECONNECT_MAX = 5 * 60 * 1000;

class Fp2Device extends Homey.Device {

  async onInit() {
    this.fp2 = null;
    this.address = null;
    this.port = null;
    this.reconnectDelay = RECONNECT_MIN;
    this.reconnectTimer = null;
    this.pollTimer = null;
    this.connecting = null;

    const { id } = this.getData();
    const where = this.getStoreValue('pairingData') ? 'in device store'
      : (this.homey.app.getPendingPairing(id) ? 'pending in app' : 'MISSING');
    this.log(`Init ${id}: pairing keys ${where}`);

    if (!(await this._loadPairingData())) {
      await this.setUnavailable(this.homey.__('error.not_paired')).catch(this.error);
    }
  }

  /**
   * Return the HomeKit keys, first claiming the ones the driver parked during
   * pairing. Called from onInit and again before every connect, because Homey
   * can start discovery for a new device before onInit has finished.
   */
  async _loadPairingData() {
    const stored = this.getStoreValue('pairingData');
    if (stored) return stored;

    const { id } = this.getData();
    const pending = this.homey.app.getPendingPairing(id);
    if (!pending) return null;

    // The backup in the app is kept until the first successful connect.
    await this.setStoreValue('pairingData', pending);
    this.log('Picked up pairing keys from pairing session');
    return pending;
  }

  // ---------- Discovery ----------

  onDiscoveryResult(result) {
    return result.id === this.getData().id;
  }

  async onDiscoveryAvailable(result) {
    this.address = result.address;
    this.port = result.port;
    try {
      await this.connect();
    } catch (err) {
      this.error('Startup failed:', err);
      throw err; // marks the device unavailable with the message
    }
  }

  onDiscoveryAddressChanged(result) {
    this.address = result.address;
    this.port = result.port;
    this.log('Address changed to', result.address);
    this.connect().catch((err) => this._onConnectFailed(err));
  }

  onDiscoveryLastSeenChanged() {
    if (!this.fp2 || !this.fp2.connected) {
      this.connect().catch((err) => this._onConnectFailed(err));
    }
  }

  // ---------- Connection ----------

  async connect() {
    // Several triggers (discovery, timer, repair) can ask at once; share one attempt.
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async _connect() {
    const pairingData = await this._loadPairingData();
    if (!pairingData) throw new Error(this.homey.__('error.not_paired'));
    if (!this.address) throw new Error(this.homey.__('error.not_found'));

    this._clearTimers();
    if (this.fp2) {
      this.fp2.removeAllListeners();
      await this.fp2.close();
    }

    this.fp2 = new Fp2Client({
      id: this.getData().id,
      address: this.address,
      port: this.port,
      pairingData,
      log: this.log.bind(this),
    });
    this.fp2.on('zone', (zone) => this._onZoneChanged(zone).catch(this.error));
    this.fp2.on('light', (lux) => this._setValue('measure_luminance', lux));
    this.fp2.on('disconnect', () => this._scheduleReconnect());

    let state;
    try {
      state = await this.fp2.connect();
    } catch (err) {
      throw new Error(this.homey.__(err.i18nKey || 'error.unreachable'));
    }

    await this._syncZones(state.zones);
    if (state.light !== null) this._setValue('measure_luminance', state.light);

    this.reconnectDelay = RECONNECT_MIN;
    this.pollTimer = this.homey.setInterval(() => this._poll(), POLL_INTERVAL);
    await this.setAvailable();
    // Keys are proven to work and live in the device store; drop the backup.
    this.homey.app.clearPendingPairing(this.getData().id);
    this.log(`Connected, ${state.zones.length} zone(s)`);
    return state;
  }

  async _poll() {
    try {
      await this.fp2.poll();
    } catch (err) {
      this.log('Poll failed, reconnecting');
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this._clearTimers();
    this.setUnavailable(this.homey.__('error.reconnecting')).catch(this.error);

    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
    this.reconnectTimer = this.homey.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => this._onConnectFailed(err));
    }, delay);
  }

  _onConnectFailed(err) {
    this.error('Connect failed:', err.message);
    // A rejected pairing will not fix itself; the user needs Repair.
    if (err.message === this.homey.__('error.not_paired')) {
      this._clearTimers();
      this.setUnavailable(err.message).catch(this.error);
      return;
    }
    this._scheduleReconnect();
  }

  _clearTimers() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    if (this.reconnectTimer) this.homey.clearTimeout(this.reconnectTimer);
    this.pollTimer = null;
    this.reconnectTimer = null;
  }

  /** Called by the driver after a successful repair. */
  async applyNewPairing(pairingData) {
    await this.setStoreValue('pairingData', pairingData);
    this.homey.app.clearPendingPairing(this.getData().id);
    const result = this.driver.getDiscoveryResult(this.getData().id);
    if (result) {
      this.address = result.address;
      this.port = result.port;
    }
    await this.connect();
  }

  // ---------- Zones ----------

  async _syncZones(zones) {
    const wanted = new Map(zones.map((zone) => [`${ZONE_PREFIX}${zone.id}`, zone]));

    // Titles we have applied, kept in the store: reading options back from
    // Homey is not reliable for a capability that was just added.
    const titles = { ...(this.getStoreValue('zoneTitles') || {}) };

    // Remove zones that were deleted in the Aqara app.
    for (const capabilityId of this.getCapabilities()) {
      if (capabilityId.startsWith(ZONE_PREFIX) && !wanted.has(capabilityId)) {
        try {
          await this.removeCapability(capabilityId);
          delete titles[capabilityId];
        } catch (err) {
          this.error(`Could not remove ${capabilityId}:`, err);
        }
      }
    }

    // Each zone is set up on its own, so one failing zone cannot take the device down.
    for (const [capabilityId, zone] of wanted) {
      let step = 'addCapability';
      try {
        if (!this.hasCapability(capabilityId)) {
          await this.addCapability(capabilityId);
        }
        if (titles[capabilityId] !== zone.name) {
          step = 'setCapabilityOptions';
          await this.setCapabilityOptions(capabilityId, {
            title: { en: zone.name, da: zone.name },
            insightsTitleTrue: { en: `${zone.name}: presence`, da: `${zone.name}: tilstedeværelse` },
            insightsTitleFalse: { en: `${zone.name}: empty`, da: `${zone.name}: tom` },
          });
          titles[capabilityId] = zone.name;
        }
      } catch (err) {
        this.error(`Zone "${zone.name}" (${capabilityId}) failed in ${step}:`, err);
        continue;
      }
      this._setValue(capabilityId, zone.occupied);
    }

    await this.setStoreValue('zoneTitles', titles);
    await this.setStoreValue('zones', zones.map(({ id, name }) => ({ id, name })));
    this.log('Zones:', zones.map((z) => `${z.name}=${z.occupied ? 'occupied' : 'empty'}`).join(', ') || 'none');
    this._updateAnyPresence();
  }

  async _onZoneChanged({ id, occupied }) {
    const capabilityId = `${ZONE_PREFIX}${id}`;
    if (!this.hasCapability(capabilityId)) return;

    this._setValue(capabilityId, occupied);
    this._updateAnyPresence();

    const zone = (this.getStoreValue('zones') || []).find((z) => z.id === id);
    const tokens = { zone: zone ? zone.name : id };
    const card = occupied ? this.driver.zoneOccupiedTrigger : this.driver.zoneVacantTrigger;
    await card.trigger(this, tokens, { zoneId: id });
  }

  _updateAnyPresence() {
    const any = this.getCapabilities()
      .filter((capabilityId) => capabilityId.startsWith(ZONE_PREFIX))
      .some((capabilityId) => this.getCapabilityValue(capabilityId) === true);
    this._setValue('alarm_motion', any);
  }

  isZoneOccupied(zoneId) {
    const capabilityId = `${ZONE_PREFIX}${zoneId}`;
    if (!this.hasCapability(capabilityId)) {
      throw new Error(this.homey.__('error.zone_missing'));
    }
    return this.getCapabilityValue(capabilityId) === true;
  }

  getZoneAutocomplete(query) {
    const q = String(query || '').toLowerCase();
    return (this.getStoreValue('zones') || [])
      .filter((zone) => zone.name.toLowerCase().includes(q))
      .map((zone) => ({ id: zone.id, name: zone.name }));
  }

  // ---------- Helpers and lifecycle ----------

  _setValue(capabilityId, value) {
    if (!this.hasCapability(capabilityId)) return;
    if (this.getCapabilityValue(capabilityId) === value) return;
    this.setCapabilityValue(capabilityId, value).catch(this.error);
  }

  async onUninit() {
    this._clearTimers();
    if (this.fp2) {
      this.fp2.removeAllListeners();
      await this.fp2.close();
    }
  }

  async onDeleted() {
    this._clearTimers();
    this.homey.app.clearPendingPairing(this.getData().id);
    if (!this.fp2) return;
    // Release the FP2 so it can be added again, here or to another controller.
    this.fp2.removeAllListeners();
    try {
      await this.fp2.unpair();
      this.log('Pairing removed from FP2; it can be added again without a reset');
    } catch (err) {
      this.error('Could not remove pairing from FP2, it will need a reset before it can be added again:', err.message);
    }
  }

}

module.exports = Fp2Device;
