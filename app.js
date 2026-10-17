'use strict';

const Homey = require('homey');
const Fp2Hub = require('./lib/Fp2Hub');

const KEYS_PREFIX = 'keys:';
const LEGACY_PENDING_PREFIX = 'pendingPairing:';

class AqaraFp2App extends Homey.App {

  async onInit() {
    this.hubs = new Map();
    this.log('Aqara FP2 app started');
  }

  /** The shared connection for one FP2, created on first use. */
  getHub(id) {
    let hub = this.hubs.get(id);
    if (!hub) {
      hub = new Fp2Hub({ id, app: this });
      this.hubs.set(id, hub);
    }
    return hub;
  }

  async removeHub(id) {
    const hub = this.hubs.get(id);
    this.hubs.delete(id);
    if (hub) await hub.destroy();
  }

  /** All Homey devices of one FP2, from both drivers (main and zones). */
  getDevicesOf(id, except = null) {
    return ['fp2', 'fp2_zone']
      .flatMap((driverId) => this.homey.drivers.getDriver(driverId).getDevices())
      .filter((device) => device !== except && device.getData().id === id);
  }

  /**
   * HomeKit keys are per FP2, shared by its main device and zone devices.
   * The app holds the working copy; every device keeps a mirror in its store
   * (see Device#onInit), so the keys survive as long as any copy exists.
   */
  getKeys(id) {
    return this.homey.settings.get(`${KEYS_PREFIX}${id}`)
      || this.homey.settings.get(`${LEGACY_PENDING_PREFIX}${id}`)
      || null;
  }

  setKeys(id, keys) {
    this.homey.settings.set(`${KEYS_PREFIX}${id}`, keys);
    this.homey.settings.unset(`${LEGACY_PENDING_PREFIX}${id}`);
  }

  deleteKeys(id) {
    this.homey.settings.unset(`${KEYS_PREFIX}${id}`);
    this.homey.settings.unset(`${LEGACY_PENDING_PREFIX}${id}`);
  }

}

module.exports = AqaraFp2App;
