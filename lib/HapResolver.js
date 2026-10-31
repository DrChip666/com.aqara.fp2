'use strict';

const dgram = require('dgram');
const dnsPacket = require('dns-packet');

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const HAP_SERVICE = '_hap._tcp.local';

/**
 * Asks the network directly for the current address and port of one HomeKit
 * accessory, identified by its HomeKit id (the TXT "id" field).
 *
 * Why: the FP2 gets a new HomeKit port every time it restarts, and Homey's
 * discovery cache can keep the old port until the app restarts. This lookup
 * bypasses that cache.
 *
 * How: a one-shot mDNS query sent from a random UDP port (a "legacy unicast"
 * query, RFC 6762 section 6.7). Responders answer directly to that port, so the
 * app never binds port 5353, which Homey itself uses. The query also sets the
 * "unicast response" bit for responders that only honour that.
 *
 * Never throws: resolves with { address, port } or null.
 */
function resolveHap(id, {
  timeout = 3000,
  fullname = null,
  target = { address: MDNS_ADDRESS, port: MDNS_PORT },
  log = () => {},
} = {}) {
  const wantedId = String(id).toUpperCase();

  return new Promise((resolve) => {
    let socket;
    let timer = null;
    let finished = false;

    // Records collected from all answers, keyed by DNS name.
    const srv = new Map(); // instance name -> { port, target }
    const txtId = new Map(); // instance name -> HomeKit id
    const hostIp = new Map(); // host name -> IPv4 address
    const senderOf = new Map(); // instance name -> IP the answer came from
    const askedFor = new Set();

    const finish = (result) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      try {
        socket.close();
      } catch (err) {
        // already closed
      }
      resolve(result);
    };

    const send = (name, type) => {
      const key = `${type} ${name}`;
      if (askedFor.has(key)) return;
      askedFor.add(key);
      const buf = dnsPacket.encode({
        type: 'query',
        id: 0,
        flags: 0,
        questions: [{ type, name, class: 'IN' }],
      });
      // Set the "unicast response" (QU) bit: the top bit of the question class,
      // which is the last two bytes of a packet with a single question.
      buf[buf.length - 2] |= 0x80; // eslint-disable-line no-bitwise
      socket.send(buf, 0, buf.length, target.port, target.address, (err) => {
        if (err) log(`mDNS send failed: ${err.code || err.message}`);
      });
    };

    const check = () => {
      for (const [instance, foundId] of txtId) {
        if (foundId !== wantedId) continue;
        const service = srv.get(instance);
        if (!service) {
          send(instance, 'SRV'); // TXT came first; ask for the port
          continue;
        }
        const address = hostIp.get(service.target) || senderOf.get(instance);
        if (address) {
          finish({ address, port: service.port });
          return;
        }
        send(service.target, 'A');
      }
    };

    const onMessage = (msg, rinfo) => {
      let packet;
      try {
        packet = dnsPacket.decode(msg);
      } catch (err) {
        return; // not a DNS packet we understand
      }
      if (packet.type !== 'response') return;

      const records = [...(packet.answers || []), ...(packet.additionals || [])];
      for (const record of records) {
        const name = String(record.name || '');
        if (record.type === 'PTR' && name.toLowerCase() === HAP_SERVICE) {
          const instance = String(record.data);
          if (!txtId.has(instance)) send(instance, 'TXT');
        } else if (record.type === 'SRV' && record.data) {
          srv.set(name, { port: record.data.port, target: record.data.target });
          senderOf.set(name, rinfo.address);
        } else if (record.type === 'TXT' && Array.isArray(record.data)) {
          for (const entry of record.data) {
            const text = Buffer.isBuffer(entry) ? entry.toString('utf8') : String(entry);
            if (text.toLowerCase().startsWith('id=')) {
              txtId.set(name, text.slice(3).toUpperCase());
              senderOf.set(name, rinfo.address);
            }
          }
        } else if (record.type === 'A' && record.data) {
          hostIp.set(name, record.data);
        }
      }
      check();
    };

    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (err) {
      log(`mDNS socket failed: ${err.code || err.message}`);
      resolve(null);
      return;
    }

    socket.on('error', (err) => {
      log(`mDNS socket error: ${err.code || err.message}`);
      finish(null);
    });
    socket.on('message', onMessage);

    timer = setTimeout(() => finish(null), timeout);

    socket.bind(0, () => {
      try {
        socket.setMulticastTTL(255);
      } catch (err) {
        // optional
      }
      // Ask for the instance we already know (fastest), and for all HomeKit
      // accessories in case the instance name changed.
      if (fullname) {
        send(fullname, 'SRV');
        send(fullname, 'TXT');
      }
      send(HAP_SERVICE, 'PTR');
    });
  });
}

module.exports = { resolveHap };
