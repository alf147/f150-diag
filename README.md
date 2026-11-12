# F-150 Diagnostics

A browser app for the 2021–2023 Ford F-150: scan modules, read and clear trouble codes, watch live data, and change module settings through an OBD adapter (OBDLink MX+, OBDLink EX, or other ELM327/STN adapters).

## Use it

- **Android:** open the site in Chrome 137 or newer. Pair the OBDLink MX+ in Android's Bluetooth settings first, then press "Connect OBDLink MX+ or USB adapter". Use Chrome's menu → "Add to Home screen" to install it; it then opens without a connection.
- **Windows:** open the site in Chrome or Edge. Pair the MX+ in Windows Bluetooth settings, or plug in a USB adapter.
- **iPhone / iPad:** browsers there cannot reach OBD adapters; only the demo truck works.

"Try the demo truck" works anywhere, with no adapter.

## Caution

The settings on the Features page come from community sources and are not verified by Ford. Every write saves a backup of the module first and reads the value back to verify it. Change one thing at a time, keep a battery charger connected, and keep the engine off while writing.
