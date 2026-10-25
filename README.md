# Aqara FP2 - Solo

Homey Pro app for the Aqara FP2 mmWave presence sensor. It connects locally over HomeKit (HAP over IP), so no cloud and no Apple device are needed.

## Features

- **Presence Sensor FP2** (driver `fp2`): the FP2 itself, with overall presence (any zone occupied) and light level in lux. Added with the HomeKit code.
- **FP2 Zone** (driver `fp2_zone`): every zone set up in the Aqara Home app can be added as its own device, renamed, placed in its own room and used with Homey's built-in Flow cards. No code needed; zones added later in the Aqara app show up when you add FP2 Zone devices again.
- One shared HomeKit connection per FP2 (`lib/Fp2Hub.js`), with automatic discovery, reconnect and repair from any device
- Deleting the last device of an FP2 releases its HomeKit pairing, so it can be added again without a reset
- Diagnostics log in the app settings (`lib/DiagLog.js`, `settings/index.html`): the last 300 events from discovery, pairing and the connection, with socket error codes. Users can copy it or send it by e-mail

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
