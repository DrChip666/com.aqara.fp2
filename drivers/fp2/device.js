'use strict';

const Homey = require('homey');

const LEGACY_ZONE_PREFIX = 'alarm_motion.zone_';

/**
 * One class for both kinds of devices:
 *  - main FP2 (data { id }): overall presence (any zone occupied) and light level
 *  - zone (data { id, zone }): presence in one zone set up in the Aqara Home app
 * All devices of the same FP2 share one connection (Fp2Hub).
 */
class Fp2Device extends Homey.Device {

  get fp2Id() {
    return this.getData().id;
  }

  get zoneId() {
    return this.getData().zone || null;
  }

  async onInit() {
    await this._syncKeys();
    if (!this.zoneId) await this._migrateFromV1();

    this.hub = this.homey.app.getHub(this.fp2Id);
    this._handlers = {
      connected: (state) => this._onConnected(state),
      disconnected: () => this.setUnavailable(this.homey.__('error.reconnecting')).catch(this.error),
      unpaired: () => this.setUnavailable(this.homey.__('error.not_paired')).catch(this.error),
      zone: (zone) => this._onZone(zone),
      light: (lux) => this._setValue('measure_luminance', lux),
    };
    for (const [event, handler] of Object.entries(this._handlers)) this.hub.on(event, handler);

    if (!this.homey.app.getKeys(this.fp2Id)) {
      this.log('No pairing keys: this FP2 was never paired with Homey');
      await this.setUnavailable(this.homey.__('error.no_keys')).catch(this.error);
    } else if (this.hub.connected) {
      this._onConnected(this.hub.state);
    }
    this.log(`Init ${this.zoneId ? `zone ${this.zoneId} of` : 'main'} ${this.fp2Id}`);
  }

  /** Keep the app's keys and this device's mirror in step; whichever exists wins. */
  async _syncKeys() {
    const appKeys = this.homey.app.getKeys(this.fp2Id);
    const ownKeys = this.getStoreValue('pairingData');
    if (appKeys && !ownKeys) {
      await this.setStoreValue('pairingData', appKeys);
    } else if (ownKeys && !appKeys) {
      this.homey.app.setKeys(this.fp2Id, ownKeys);
      this.log('Restored pairing keys from device store');
    } else if (appKeys && ownKeys && JSON.stringify(appKeys) !== JSON.stringify(ownKeys)) {
      await this.setStoreValue('pairingData', appKeys); // the app's copy is the newest (repair)
    }
  }

  /** Version 1.x kept every zone as a sub-capability on this device. Zones are now devices. */
  async _migrateFromV1() {
    for (const capabilityId of this.getCapabilities()) {
      if (capabilityId.startsWith(LEGACY_ZONE_PREFIX)) {
        await this.removeCapability(capabilityId).catch(this.error);
      }
    }
    if (!this.hasCapability('measure_luminance')) {
      await this.addCapability('measure_luminance').catch(this.error);
    }
    // 'zoneNames' is kept on purpose: pairing uses it as default names for zone devices.
    for (const key of ['zoneTitles', 'zones']) {
      if (this.getStoreValue(key) !== undefined) await this.unsetStoreValue(key).catch(this.error);
    }
  }

  // ---------- Discovery: every device of this FP2 gets the same result ----------

  onDiscoveryResult(result) {
    return result.id === this.fp2Id;
  }

  async onDiscoveryAvailable(result) {
    this.hub.setTarget(result.address, result.port);
    try {
      const state = await this.hub.ensureConnected();
      this._onConnected(state);
    } catch (err) {
      this.error('Startup failed:', err.message);
      if (err.i18nKey === 'error.not_paired' && !this.homey.app.getKeys(this.fp2Id)) {
        throw new Error(this.homey.__('error.no_keys'));
      }
      throw new Error(this.homey.__(err.i18nKey || 'error.unreachable'));
    }
  }

  onDiscoveryAddressChanged(result) {
    this.hub.setTarget(result.address, result.port);
  }

  onDiscoveryLastSeenChanged(result) {
    this.hub.setTarget(result.address, result.port);
    if (!this.hub.connected) this.hub.ensureConnected().catch(() => {});
  }

  // ---------- State ----------

  _onConnected(state) {
    if (!state) return;
    if (this.zoneId) {
      const zone = state.zones.find((z) => z.id === this.zoneId);
      if (!zone) {
        this.setUnavailable(this.homey.__('error.zone_missing')).catch(this.error);
        return;
      }
      this._setValue('alarm_motion', zone.occupied);
    } else {
      this._setValue('alarm_motion', state.zones.some((z) => z.occupied));
      if (state.light !== null) this._setValue('measure_luminance', state.light);
    }
    this.setAvailable().catch(this.error);
  }

  _onZone({ id, occupied }) {
    if (this.zoneId) {
      if (id === this.zoneId) this._setValue('alarm_motion', occupied);
    } else if (this.hub.state) {
      this._setValue('alarm_motion', this.hub.state.zones.some((z) => z.occupied));
    }
  }

  _setValue(capabilityId, value) {
    if (!this.hasCapability(capabilityId)) return;
    if (this.getCapabilityValue(capabilityId) === value) return;
    this.setCapabilityValue(capabilityId, value).catch(this.error);
  }

  // ---------- Lifecycle ----------

  _detach() {
    if (!this.hub || !this._handlers) return;
    for (const [event, handler] of Object.entries(this._handlers)) this.hub.off(event, handler);
    this._handlers = null;
  }

  async onUninit() {
    this._detach();
  }

  async onDeleted() {
    this._detach();
    const remaining = this.homey.app.getDevicesOf(this.fp2Id, this);
    if (remaining.length > 0) return; // other devices still use this FP2

    // Last device of this FP2: release it so it can be added again without a reset.
    try {
      if (await this.hub.unpair()) {
        this.log('Pairing removed from FP2; it can be added again without a reset');
      } else {
        this.log('Homey had no pairing with this FP2, so there was nothing to remove');
      }
    } catch (err) {
      this.error('Could not remove pairing from FP2, it will need a reset before it can be added again:', err.message);
    }
    this.homey.app.deleteKeys(this.fp2Id);
    await this.homey.app.removeHub(this.fp2Id);
  }

}

module.exports = Fp2Device;
