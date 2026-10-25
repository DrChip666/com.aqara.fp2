'use strict';

const { Fp2DriverBase, shortId } = require('../../lib/Fp2DriverBase');

/**
 * Zone devices: one list with the zones of every FP2 that is already paired.
 * Homey hides zones that are already added, so running this again later only
 * shows new zones. No HomeKit code is needed here.
 */
class Fp2ZoneDriver extends Fp2DriverBase {

  async onPairListDevices() {
    const results = Object.values(this.getDiscoveryStrategy().getDiscoveryResults());
    const paired = results.filter((result) => this.homey.app.getKeys(result.id));
    this.log(`Zone list: ${paired.length} paired FP2(s) on the network`);
    this.homey.app.diag.add('zones', 'Zone list requested', { pairedOnNetwork: paired.length, onNetwork: results.length });
    if (paired.length === 0) throw new Error(this.homey.__('error.add_fp2_first'));

    const devices = [];
    for (const result of paired) {
      const { id } = result;
      const hub = this.homey.app.getHub(id);
      hub.setTarget(result.address, result.port);

      let state;
      try {
        // Always read the zones fresh, so zones drawn in the Aqara app since pairing show up.
        state = await hub.refresh();
      } catch (err) {
        this.error(`Could not read zones of ${id}:`, err.message);
        this.homey.app.diag.error('zones', 'Could not read zones', err.cause || err, {
          id, address: result.address, port: result.port, result: err.i18nKey,
        });
        continue; // other FP2s can still be listed
      }

      const suffix = shortId(id);
      // Names typed into the "Zone names" setting of version 1.1 become the default names.
      const main = this.homey.app.getDevicesOf(id).find((device) => !device.getData().zone);
      const oldNames = (main && main.getStoreValue('zoneNames')) || {};
      const keys = this.homey.app.getKeys(id);

      for (const zone of state.zones) {
        devices.push({
          name: oldNames[zone.id] || `FP2 ${suffix} ${zone.name}`,
          data: { id, zone: zone.id },
          store: { pairingData: keys },
        });
      }
    }

    if (devices.length === 0) throw new Error(this.homey.__('error.unreachable'));
    return devices;
  }

}

module.exports = Fp2ZoneDriver;
