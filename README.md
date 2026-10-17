# Aqara FP2 - Solo

Homey Pro app for the Aqara FP2 mmWave presence sensor. It connects locally over HomeKit (HAP over IP), so no cloud and no Apple device are needed.

## Features

- One Homey device per FP2, with a presence status for every zone set up in the Aqara Home app
- Overall presence (any zone occupied) and light level in lux
- Flow cards: presence detected in a zone, a zone became empty, someone is / isn't in a zone
- Automatic discovery, reconnect and repair; deleting the device releases the FP2's HomeKit pairing

## Requirements

Homey Pro with Homey 12.9.0 or newer, on the same network as the FP2. The FP2 can only have one HomeKit controller at a time, so it must not be paired with Apple Home or another HomeKit app.

## Development

```
npm install
homey app run
```

Do not use `homey app run --clean` while FP2 devices are paired: it deletes the HomeKit keys on Homey, but the FP2 keeps the pairing and then needs a reset before it can be added again.

`hap-controller` pulls in a Bluetooth module with a native build that fails on Homey. This app only uses IP, so `package.json` overrides it with an empty stub in `lib/noble-stub`, and `.npmrc` sets `install-links=true` so the stub is copied instead of symlinked (symlinks fail in the Homey build on Windows).

## Credits

HomeKit communication uses [hap-controller](https://github.com/Apollon77/hap-controller-node) (MPL-2.0).

Not affiliated with or endorsed by Aqara.
