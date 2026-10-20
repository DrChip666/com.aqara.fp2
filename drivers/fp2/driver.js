'use strict';

const { Fp2DriverBase, shortId } = require('../../lib/Fp2DriverBase');

/**
 * Main FP2 device: choose the FP2, enter its HomeKit code, add.
 * Zones are added with the separate "FP2 Zone" driver.
 */
class Fp2Driver extends Fp2DriverBase {

  async onPair(session) {
    let selectedId = null;

    session.setHandler('list_devices', async () => {
      const results = await this.getLiveDiscoveryResults();
      return results.map((result) => ({
        name: `Aqara FP2 ${shortId(result.id)}`,
        data: { id: result.id },
      }));
    });

    session.setHandler('list_devices_selection', async (devices) => {
      if (devices && devices[0]) selectedId = devices[0].data.id;
    });

    session.setHandler('pincode', async (pincode) => {
      if (!selectedId) throw new Error(this.homey.__('error.not_found'));
      // The keys go to the app; the new device copies them into its store in onInit.
      await this.pairWithCode(selectedId, pincode.join(''));
      return true;
    });
  }

}

module.exports = Fp2Driver;
