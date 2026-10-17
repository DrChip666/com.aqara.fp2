'use strict';

const Homey = require('homey');

const PENDING_PREFIX = 'pendingPairing:';

class AqaraFp2App extends Homey.App {

  async onInit() {
    this.log('Aqara FP2 app started');
  }

  /**
   * HomeKit pairing happens in the pincode step, before Homey creates the
   * device. The keys are parked here until the new device picks them up in
   * onInit. They also let a cancelled pairing be resumed: the FP2 already
   * trusts these keys, so asking it to pair again would fail.
   */
  getPendingPairing(id) {
    return this.homey.settings.get(`${PENDING_PREFIX}${id}`) || null;
  }

  setPendingPairing(id, pairingData) {
    this.homey.settings.set(`${PENDING_PREFIX}${id}`, pairingData);
  }

  clearPendingPairing(id) {
    this.homey.settings.unset(`${PENDING_PREFIX}${id}`);
  }

}

module.exports = AqaraFp2App;
