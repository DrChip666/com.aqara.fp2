'use strict';

const Homey = require('homey');
const { Fp2Client } = require('../../lib/Fp2Client');

class Fp2Driver extends Homey.Driver {

  async onInit() {
    this.zoneOccupiedTrigger = this.homey.flow.getDeviceTriggerCard('zone_occupied');
    this.zoneVacantTrigger = this.homey.flow.getDeviceTriggerCard('zone_vacant');

    for (const card of [this.zoneOccupiedTrigger, this.zoneVacantTrigger]) {
      card.registerRunListener(async (args, state) => args.zone.id === state.zoneId);
      card.registerArgumentAutocompleteListener('zone', async (query, args) => args.device.getZoneAutocomplete(query));
    }

    const zoneCondition = this.homey.flow.getConditionCard('zone_is_occupied');
    zoneCondition.registerRunListener(async (args) => args.device.isZoneOccupied(args.zone.id));
    zoneCondition.registerArgumentAutocompleteListener('zone', async (query, args) => args.device.getZoneAutocomplete(query));
  }

  /** Current mDNS result for a HomeKit device ID, or null when not on the network. */
  getDiscoveryResult(id) {
    const results = this.getDiscoveryStrategy().getDiscoveryResults();
    return results[id] || null;
  }

  async onPair(session) {
    let selected = null;

    session.setHandler('list_devices', async () => {
      const results = Object.values(this.getDiscoveryStrategy().getDiscoveryResults());
      return results.map((result) => ({
        name: `Aqara FP2 ${String(result.id).replace(/:/g, '').slice(-4).toUpperCase()}`,
        data: { id: result.id },
      }));
    });

    session.setHandler('list_devices_selection', async (devices) => {
      [selected] = devices;
    });

    session.setHandler('pincode', async (pincode) => {
      if (!selected) throw new Error(this.homey.__('error.not_found'));
      await this._pairWithCode(selected.data.id, pincode.join(''));
      return true;
    });
  }

  async onRepair(session, device) {
    session.setHandler('pincode', async (pincode) => {
      const { id } = device.getData();
      // A stale pairing on the Homey side must not be reused when repairing.
      this.homey.app.clearPendingPairing(id);
      const pairingData = await this._pairWithCode(id, pincode.join(''));
      await device.applyNewPairing(pairingData);
      return true;
    });
  }

  /**
   * Pair with the FP2 and park the keys in the app until the device exists.
   * Throws an Error with a translated message on failure.
   */
  async _pairWithCode(id, code) {
    const result = this.getDiscoveryResult(id);
    if (!result) throw new Error(this.homey.__('error.not_found'));

    const target = { id, address: result.address, port: result.port };

    try {
      // Resume an earlier pairing that was interrupted before the device was added.
      const pending = this.homey.app.getPendingPairing(id);
      if (pending) {
        if (await this._pairingStillValid(target, pending)) return pending;
        this.homey.app.clearPendingPairing(id);
      }

      // sf=1 means open for pairing, 0 means it already has a controller. Homey can
      // cache an old record, so only log it and let the FP2 itself answer.
      this.log('Pairing with', id, 'at', `${result.address}:${result.port}`, 'txt:', JSON.stringify(result.txt));

      const pairingData = await Fp2Client.pair({
        ...target,
        pin: code,
        featureFlags: result.txt ? result.txt.ff : 0,
      });
      this.homey.app.setPendingPairing(id, pairingData);
      this.log(`Paired with ${id}, keys saved in app until the device has connected`);
      return pairingData;
    } catch (err) {
      this.error('Pairing failed:', err.cause || err);
      throw new Error(this.homey.__(err.i18nKey || 'error.pairing_failed'));
    }
  }

  async _pairingStillValid(target, pairingData) {
    const client = new Fp2Client({ ...target, pairingData, log: this.log.bind(this) });
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

module.exports = Fp2Driver;
