'use strict';

const Homey = require('homey');
const { Fp2Client } = require('./Fp2Client');

function shortId(id) {
  return String(id).replace(/:/g, '').slice(-4).toUpperCase();
}

/** Shared by the main FP2 driver and the zone driver. */
class Fp2DriverBase extends Homey.Driver {

  /** Current mDNS result for a HomeKit device ID, or null when not on the network. */
  getDiscoveryResult(id) {
    const results = this.getDiscoveryStrategy().getDiscoveryResults();
    return results[id] || null;
  }

  /** Repair, available on every device: enter the HomeKit code again. */
  async onRepair(session, device) {
    session.setHandler('pincode', async (pincode) => {
      const { id } = device.getData();
      // Keys that still work are kept; otherwise the FP2 is paired again with the code.
      const keys = await this.pairWithCode(id, pincode.join(''));
      for (const other of this.homey.app.getDevicesOf(id)) {
        await other.setStoreValue('pairingData', keys);
      }
      await this.homey.app.getHub(id).reconnect()
        .catch((err) => this.error('Reconnect after repair failed:', err.message));
      return true;
    });
  }

  /**
   * Pair with the FP2 (or reuse keys that still work) and store the keys in the app.
   * Throws an Error with a translated message on failure.
   */
  async pairWithCode(id, code) {
    const result = this.getDiscoveryResult(id);
    if (!result) throw new Error(this.homey.__('error.not_found'));
    const target = { id, address: result.address, port: result.port };

    try {
      const existing = this.homey.app.getKeys(id);
      if (existing && await this._keysStillValid(target, existing)) {
        this.log(`Existing keys for ${id} still work, reusing them`);
        return existing;
      }

      // sf=1 means open for pairing, 0 means it already has a controller. Homey can
      // cache an old record, so only log it and let the FP2 itself answer.
      this.log('Pairing with', id, 'at', `${result.address}:${result.port}`, 'txt:', JSON.stringify(result.txt));

      const keys = await Fp2Client.pair({
        ...target,
        pin: code,
        featureFlags: result.txt ? result.txt.ff : 0,
      });
      this.homey.app.setKeys(id, keys);
      this.log(`Paired with ${id}, keys saved`);
      return keys;
    } catch (err) {
      this.error('Pairing failed:', err.cause || err);
      throw new Error(this.homey.__(err.i18nKey || 'error.pairing_failed'));
    }
  }

  async _keysStillValid(target, pairingData) {
    const client = new Fp2Client({ ...target, pairingData });
    try {
      await client.connect();
      return true;
    } catch (err) {
      return false;
    } finally {
      await client.close();
    }
  }

}

module.exports = { Fp2DriverBase, shortId };
