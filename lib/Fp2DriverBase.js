'use strict';

const net = require('net');
const Homey = require('homey');
const { Fp2Client } = require('./Fp2Client');

/** True when something accepts TCP connections on address:port within the timeout. */
function isReachable(address, port, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

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

  /**
   * Discovery results that answer on their HomeKit port. After a reset an FP2
   * gets a new HomeKit ID, and Homey keeps announcing the old one for a while
   * on a port that is closed; those are left out. Throws a clear, translated
   * message when Homey sees no FP2 at all, or none of them answers.
   */
  async getLiveDiscoveryResults() {
    const results = Object.values(this.getDiscoveryStrategy().getDiscoveryResults());
    this.log(`Discovery: ${results.length} FP2 entr${results.length === 1 ? 'y' : 'ies'} on the network`
      + (results.length ? `: ${results.map((r) => `${r.id} at ${r.address}:${r.port}`).join(', ')}` : ''));
    if (results.length === 0) throw new Error(this.homey.__('error.none_found'));

    const live = [];
    await Promise.all(results.map(async (result) => {
      if (await isReachable(result.address, result.port)) live.push(result);
      else this.log(`Hiding ${result.id} at ${result.address}:${result.port}: not answering (old entry or offline)`);
    }));
    if (live.length === 0) throw new Error(this.homey.__('error.none_answering'));
    return live;
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
      // Use the current address: a device that never got online may not know it yet.
      const hub = this.homey.app.getHub(id);
      const result = this.getDiscoveryResult(id);
      if (result) hub.setTarget(result.address, result.port);
      await hub.reconnect()
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

module.exports = { Fp2DriverBase, shortId, isReachable };
