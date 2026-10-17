'use strict';

const { EventEmitter } = require('events');
const {
  HttpClient, Service, Characteristic, PairMethods,
} = require('hap-controller');

const SERVICE_OCCUPANCY = 'public.hap.service.sensor.occupancy';
const SERVICE_LIGHT = 'public.hap.service.sensor.light';
const CHAR_OCCUPANCY = 'public.hap.characteristic.occupancy-detected';
const CHAR_LIGHT_LEVEL = 'public.hap.characteristic.light-level.current';
const CHAR_NAME = 'public.hap.characteristic.name';
const CHAR_CONFIGURED_NAME = 'public.hap.characteristic.configured-name';

// HomeKit TLV error codes returned during pair setup (HAP spec, table 5-5).
const HAP_ERROR = {
  AUTHENTICATION: 2,
  BACKOFF: 3,
  MAX_PEERS: 4,
  MAX_TRIES: 5,
  UNAVAILABLE: 6,
  BUSY: 7,
};

/**
 * Error with a key from /locales/*.json under "error", so the device or
 * driver can show a translated message to the user.
 */
class Fp2Error extends Error {
  constructor(key, cause) {
    super(key);
    this.i18nKey = `error.${key}`;
    this.cause = cause;
  }
}

function serviceType(type) {
  try {
    return Service.serviceFromUuid(type);
  } catch (err) {
    return null;
  }
}

function characteristicType(type) {
  try {
    return Characteristic.characteristicFromUuid(type);
  } catch (err) {
    return null;
  }
}

/**
 * Talks to one Aqara FP2 over HomeKit (HAP over IP).
 *
 * Events:
 *  - 'zone'       ({ id, occupied })   a zone's presence changed
 *  - 'light'      (lux)                the light level changed
 *  - 'disconnect' ()                   the event connection was lost
 */
class Fp2Client extends EventEmitter {

  /**
   * Pair Homey with an FP2 as a new HomeKit controller.
   *
   * @param {object} opts
   * @param {string} opts.id - HomeKit device ID (txt.id from mDNS)
   * @param {string} opts.address - IP address
   * @param {number} opts.port - HAP port
   * @param {string} opts.pin - 8 digits, with or without dashes
   * @param {number} [opts.featureFlags] - txt.ff from mDNS
   * @returns {Promise<object>} long-term pairing data to store
   */
  static async pair({
    id, address, port, pin, featureFlags = 0,
  }) {
    const digits = String(pin).replace(/\D/g, '');
    if (digits.length !== 8) throw new Fp2Error('invalid_code');
    const formattedPin = `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;

    // Devices that announce hardware authentication (ff bit 0) expect
    // "pair setup with auth"; others, like most Wi-Fi sensors, use plain pair setup.
    const method = (Number(featureFlags) & 1) ? PairMethods.PairSetupWithAuth : PairMethods.PairSetup;

    const client = new HttpClient(id, address, port);
    try {
      await client.pairSetup(formattedPin, method);
      return client.getLongTermData();
    } catch (err) {
      throw Fp2Client._translatePairError(err);
    } finally {
      await client.close().catch(() => {});
    }
  }

  static _translatePairError(err) {
    // hap-controller rejects trivial codes such as 12345678 locally (not allowed by HomeKit).
    if (err && /invalid pin/i.test(err.message)) return new Fp2Error('wrong_code', err);
    // The FP2 is on the network but not (yet) accepting HomeKit connections,
    // typically right after a restart, when it may also have moved to a new port.
    if (err && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(err.code)) {
      return new Fp2Error('not_ready', err);
    }
    const code = err && typeof err.statusCode === 'number' ? err.statusCode : null;
    switch (code) {
      case HAP_ERROR.AUTHENTICATION: return new Fp2Error('wrong_code', err);
      case HAP_ERROR.UNAVAILABLE:
      case HAP_ERROR.MAX_PEERS: return new Fp2Error('already_paired', err);
      case HAP_ERROR.BUSY:
      case HAP_ERROR.BACKOFF: return new Fp2Error('busy', err);
      case HAP_ERROR.MAX_TRIES: return new Fp2Error('max_tries', err);
      default: return new Fp2Error('pairing_failed', err);
    }
  }

  constructor({
    id, address, port, pairingData, log,
  }) {
    super();
    this.id = id;
    this.address = address;
    this.port = port;
    this.pairingData = pairingData;
    this.log = log || (() => {});

    this.client = null;
    this.zones = new Map(); // 'aid.iid' of occupancy characteristic -> { id, name, occupied }
    this.lightCharacteristic = null; // 'aid.iid'
    this.light = null;
  }

  get connected() {
    return this.client !== null;
  }

  /**
   * Connect, read the accessory database and subscribe to events.
   * Resolves with the current state: { zones: [{ id, name, occupied }], light }.
   */
  async connect() {
    await this.close();

    const client = new HttpClient(this.id, this.address, this.port, this.pairingData, {
      usePersistentConnections: true,
    });
    client.on('event', (event) => this._onEvent(event));
    client.on('event-disconnect', () => {
      this.log('Event connection to FP2 lost');
      this.emit('disconnect');
    });

    let accessories;
    try {
      ({ accessories } = await client.getAccessories());
    } catch (err) {
      await client.close().catch(() => {});
      if (err && (err.statusCode === 470 || /pair verify|M2|M4/i.test(err.message))) {
        throw new Fp2Error('not_paired', err);
      }
      throw new Fp2Error('unreachable', err);
    }

    this._parseAccessories(accessories);

    const subscriptions = [...this.zones.keys()];
    if (this.lightCharacteristic) subscriptions.push(this.lightCharacteristic);
    if (subscriptions.length > 0) {
      await client.subscribeCharacteristics(subscriptions);
    }

    this.client = client;
    return this.getState();
  }

  getState() {
    return {
      zones: [...this.zones.values()].map(({ id, name, occupied }) => ({ id, name, occupied })),
      light: this.light,
    };
  }

  /**
   * Light read to confirm the device still answers. Also refreshes values,
   * in case an event was missed. Throws when the FP2 does not respond.
   */
  async poll() {
    if (!this.client) throw new Fp2Error('unreachable');
    const ids = [...this.zones.keys()];
    if (this.lightCharacteristic) ids.push(this.lightCharacteristic);
    if (ids.length === 0) return;

    try {
      const { characteristics } = await this.client.getCharacteristics(ids);
      this._applyValues(characteristics);
    } catch (err) {
      throw new Fp2Error('unreachable', err);
    }
  }

  /**
   * Remove Homey's pairing from the FP2 so it can be added to another
   * controller again. Best effort: the FP2 may be offline.
   */
  async unpair() {
    if (!this.pairingData) return;
    const client = this.client || new HttpClient(this.id, this.address, this.port, this.pairingData);
    try {
      await client.removePairing(this.pairingData.iOSDevicePairingID);
    } finally {
      await client.close().catch(() => {});
      this.client = null;
    }
  }

  async close() {
    const { client } = this;
    this.client = null;
    if (!client) return;
    client.removeAllListeners();
    await client.close().catch(() => {});
  }

  _parseAccessories(accessories) {
    this.zones.clear();
    this.lightCharacteristic = null;

    for (const accessory of accessories || []) {
      const aid = Number(accessory.aid);
      for (const service of accessory.services || []) {
        const type = serviceType(service.type);
        if (type !== SERVICE_OCCUPANCY && type !== SERVICE_LIGHT) continue;

        const chars = {};
        for (const characteristic of service.characteristics || []) {
          const charType = characteristicType(characteristic.type);
          if (charType) chars[charType] = characteristic;
        }

        if (type === SERVICE_OCCUPANCY && chars[CHAR_OCCUPANCY]) {
          const key = `${aid}.${Number(chars[CHAR_OCCUPANCY].iid)}`;
          const nameChar = chars[CHAR_CONFIGURED_NAME] || chars[CHAR_NAME];
          this.zones.set(key, {
            // aid + service iid: stable as long as the zone exists in the Aqara app
            id: `${aid}_${Number(service.iid)}`,
            name: (nameChar && nameChar.value) ? String(nameChar.value).trim() : null,
            occupied: Boolean(chars[CHAR_OCCUPANCY].value),
          });
        }

        if (type === SERVICE_LIGHT && chars[CHAR_LIGHT_LEVEL] && !this.lightCharacteristic) {
          this.lightCharacteristic = `${aid}.${Number(chars[CHAR_LIGHT_LEVEL].iid)}`;
          const value = Number(chars[CHAR_LIGHT_LEVEL].value);
          this.light = Number.isFinite(value) ? value : null;
        }
      }
    }

    // Give unnamed zones a predictable fallback name, numbered in order.
    let index = 1;
    for (const zone of this.zones.values()) {
      if (!zone.name) zone.name = `Zone ${index}`;
      index += 1;
    }
  }

  _onEvent(event) {
    if (event && Array.isArray(event.characteristics)) {
      this._applyValues(event.characteristics);
    }
  }

  _applyValues(characteristics) {
    for (const { aid, iid, value } of characteristics || []) {
      if (value === undefined || value === null) continue;
      const key = `${Number(aid)}.${Number(iid)}`;

      const zone = this.zones.get(key);
      if (zone) {
        const occupied = Boolean(Number(value));
        if (occupied !== zone.occupied) {
          zone.occupied = occupied;
          this.emit('zone', { id: zone.id, occupied });
        }
        continue;
      }

      if (key === this.lightCharacteristic) {
        const lux = Number(value);
        if (Number.isFinite(lux) && lux !== this.light) {
          this.light = lux;
          this.emit('light', lux);
        }
      }
    }
  }

}

module.exports = { Fp2Client, Fp2Error };
