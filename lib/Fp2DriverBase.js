'use strict';

const net = require('net');
const Homey = require('homey');
const { Fp2Client } = require('./Fp2Client');

/**
 * Tries a TCP connection to address:port. Resolves with
 * { ok, code, ms }: code is the socket error (ECONNREFUSED, EHOSTUNREACH ...)
 * or 'TIMEOUT', so the diagnostics log can tell a closed port from a network problem.
 */
function probe(address, port, timeout = 3000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port });
    const done = (ok, code = null) => {
      socket.destroy();
      resolve({ ok, code, ms: Date.now() - started });
    };
    socket.setTimeout(timeout, () => done(false, 'TIMEOUT'));
    socket.once('connect', () => done(true));
    socket.once('error', (err) => done(false, err.code || err.message));
  });
}

/** True when something accepts TCP connections on address:port within the timeout. */
async function isReachable(address, port, timeout = 3000) {
  return (await probe(address, port, timeout)).ok;
}

/** The mDNS fields that matter when reading a diagnostics log. */
function describeResult(result) {
  const txt = result.txt || {};
  return {
    id: result.id,
    address: result.address,
    port: result.port,
    sf: txt.sf,
    model: txt.md,
    config: txt['c#'],
    lastSeen: result.lastSeen,
  };
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
    const { diag } = this.homey.app;
    const results = Object.values(this.getDiscoveryStrategy().getDiscoveryResults());
    this.log(`Discovery: ${results.length} FP2 entr${results.length === 1 ? 'y' : 'ies'} on the network`
      + (results.length ? `: ${results.map((r) => `${r.id} at ${r.address}:${r.port}`).join(', ')}` : ''));
    diag.add('discovery', `${results.length} FP2 entr${results.length === 1 ? 'y' : 'ies'} on the network`);
    for (const result of results) diag.add('discovery', 'Found', describeResult(result));
    if (results.length === 0) throw new Error(this.homey.__('error.none_found'));

    const live = [];
    await Promise.all(results.map(async (result) => {
      const check = await probe(result.address, result.port);
      if (check.ok) {
        live.push(result);
        diag.add('probe', 'Answering', { id: result.id, address: result.address, port: result.port, ms: check.ms });
      } else {
        this.log(`Hiding ${result.id} at ${result.address}:${result.port}: not answering (old entry or offline), ${check.code} after ${check.ms} ms`);
        diag.add('probe', 'Not answering', {
          id: result.id, address: result.address, port: result.port, code: check.code, ms: check.ms,
        });
      }
    }));
    if (live.length === 0) throw new Error(this.homey.__('error.none_answering'));
    return live;
  }

  /** Repair, available on every device: enter the HomeKit code again. */
  async onRepair(session, device) {
    session.setHandler('pincode', async (pincode) => {
      const { id } = device.getData();
      this.homey.app.diag.add('repair', 'Repair started', { id });
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
    const { diag } = this.homey.app;
    const result = this.getDiscoveryResult(id);
    if (!result) {
      diag.add('pair', 'FP2 not in discovery results', { id });
      throw new Error(this.homey.__('error.not_found'));
    }
    const target = { id, address: result.address, port: result.port };

    try {
      const existing = this.homey.app.getKeys(id);
      if (existing && await this._keysStillValid(target, existing)) {
        this.log(`Existing keys for ${id} still work, reusing them`);
        diag.add('pair', 'Existing keys still work, reusing them', { id });
        return existing;
      }

      // sf=1 means open for pairing, 0 means it already has a controller. Homey can
      // cache an old record, so only log it and let the FP2 itself answer.
      this.log('Pairing with', id, 'at', `${result.address}:${result.port}`, 'txt:', JSON.stringify(result.txt));
      // Never log the HomeKit code itself.
      diag.add('pair', 'Pair setup started', describeResult(result));

      const keys = await Fp2Client.pair({
        ...target,
        pin: code,
        featureFlags: result.txt ? result.txt.ff : 0,
      });
      this.homey.app.setKeys(id, keys);
      this.log(`Paired with ${id}, keys saved`);
      diag.add('pair', 'Pair setup succeeded, keys saved', { id });
      return keys;
    } catch (err) {
      this.error('Pairing failed:', err.cause || err);
      diag.error('pair', 'Pair setup failed', err.cause || err, {
        id, address: result.address, port: result.port, result: err.i18nKey,
      });
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

module.exports = {
  Fp2DriverBase, shortId, isReachable, probe,
};
