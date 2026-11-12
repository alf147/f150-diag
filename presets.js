'use strict';
/* Community-documented settings for the 2021-2023 F-150 (gas and PowerBoost).

   Every value below was transcribed from public community sources: the "2021+ F-150
   FORScan" spreadsheet as indexed at f150mods.us (each entry's `src` is its page there).
   None of it has been verified on a vehicle by this app's author. Values vary by year,
   trim and options, so the app shows what your truck currently holds and the exact bytes
   it would change before anything is written.

   Notation is the one the sources use: "726-63-02 xxx0 xxxx xx--" means module 726,
   block 63, line 2, with the written digits set and every x left alone ("--" is the
   line checksum, which is not part of the data). Block numbers are decimal.
   Where a source says "add" or "subtract" a value, the entry names the single bit instead.

   Deliberately left out: seat-belt reminder changes, BlueCruise and other driver-assist
   module changes, camera-at-speed changes, Auto Start/Stop and active air dam changes,
   DRL brightness, glare-free headlamps (values depend on bed length and options),
   tire size (needs a number and a relearn), and Lightning-only or 2024+ entries. */

const F150_PRESETS = [
  /* SYNC 4 screen (APIM) */
  { id: 'p-splash', src: 'splash-screen', name: 'SYNC startup splash screen',
    note: 'Needs SYNC software 22012 or newer. Your truck\'s own splash is kept as "Original" once you change it.',
    choices: [['75th Anniversary', '7D0-03-01 xxxx 24xx xx--'], ['Lightning', '7D0-03-01 xxxx 1Fxx xx--']] },
  { id: 'p-unreal', src: 'unreal-sync-theme', name: 'Newer SYNC 4 graphics theme (Unreal)',
    note: 'Needs recent SYNC software.',
    on: ['7D0-02-03 xxxx xxx1 xx--'] },
  { id: 'p-climate-bar', src: 'climate-bar', name: 'Climate bar along the bottom of the SYNC screen',
    note: 'Needs the newer graphics theme above on 2021-2024 trucks.',
    on: [{ loc: '7D0-02-02', byte: 1, mask: 0x02, value: 0x02 }], off: [{ loc: '7D0-02-02', byte: 1, mask: 0x02, value: 0x00 }] },
  { id: 'p-full-view', src: 'remove-full-view-not-available', name: 'Remove the "Full view not available" box on the camera screen',
    on: [{ loc: '7D0-02-02', byte: 1, mask: 0x01, value: 0x01 }], off: [{ loc: '7D0-02-02', byte: 1, mask: 0x01, value: 0x00 }] },
  { id: 'p-silent', src: 'silent-mode', name: 'Silent Mode switch in SYNC',
    note: 'Adds a SYNC switch that quiets approach lighting and the lock horn until the truck is started.',
    on: [{ loc: '7D0-09-02', byte: 0, mask: 0x10, value: 0x10 }], off: [{ loc: '7D0-09-02', byte: 0, mask: 0x10, value: 0x00 }] },
  { id: 'p-oil-life', src: 'oil-life-in-sync', name: 'Oil life percentage in SYNC vehicle settings',
    on: ['7D0-10-01 x8xx xxxx xx--'] },

  /* Instrument cluster (IPC) */
  { id: 'p-temp-gauges', src: 'digital-temp-gauges', name: 'Digital coolant and transmission temperature readouts',
    note: '12-inch digital cluster only. Pick the line that matches your engine and whether you have a trailer brake controller.',
    choices: [
      ['Turbo engine, with trailer brake controller', '720-07-01 xxxx xE5x xx--'],
      ['Turbo engine, no trailer brake controller', '720-07-01 xxxx x65x xx--'],
      ['Non-turbo engine, with trailer brake controller', '720-07-01 xxxx xA5x xx--'],
      ['Non-turbo engine, no trailer brake controller', '720-07-01 xxxx x25x xx--']] },
  { id: 'p-door-ajar', src: 'door-ajar-chime-disable-2021', name: 'Silence the door-ajar chime',
    on: [{ loc: '720-01-02', byte: 1, mask: 0x20, value: 0x00 }], off: [{ loc: '720-01-02', byte: 1, mask: 0x20, value: 0x20 }] },
  { id: 'p-key-chime', src: 'key-in-ignition-chime-disable', name: 'Silence the key-in-ignition chime',
    note: 'Keyed-ignition trucks only.',
    on: [{ loc: '720-02-01', byte: 1, mask: 0x80, value: 0x00 }], off: [{ loc: '720-02-01', byte: 1, mask: 0x80, value: 0x80 }] },
  { id: 'p-idle-shutdown', src: 'idle-shutdown-default-off', name: 'Stop the 30-minute idle shutdown timer re-arming at every start', risk: 'medium',
    note: 'Extended idling may be restricted where you live.',
    on: [{ loc: '720-01-01', byte: 0, mask: 0x08, value: 0x00 }], off: [{ loc: '720-01-01', byte: 0, mask: 0x08, value: 0x08 }] },

  /* Body (BCM) */
  { id: 'p-double-honk', src: 'double-honk-disable-2021', name: 'Disable the double honk when leaving the running truck with the key',
    on: ['726-63-02 xxx0 xxxx xx--'], off: ['726-63-02 xxx1 xxxx xx--'] },
  { id: 'p-bambi', src: 'bambi-mode-2021', name: 'Fog lights stay on with high beams',
    note: 'Trucks with fog lamps. Check local fog-lamp rules.',
    on: ['726-39-02 xxx0 xxxx xx--'], off: ['726-39-02 xxx1 xxxx xx--'] },
  { id: 'p-fogs-drl', src: 'drl-allow-fogs', name: 'Allow fog lights with daytime running lights',
    note: 'Trucks with fog lamps.',
    on: ['726-38-02 00xx xxxx xx--'] },
  { id: 'p-drl-park', src: 'drl-include-parking-lamps', name: 'Parking and tail lamps on with daytime running lights',
    on: ['726-38-01 xxxx xxxx 01--'] },
  { id: 'p-headlamp-last', src: 'headlamp-switch-last-position', name: 'Headlamp switch remembers its last position', risk: 'medium',
    note: 'The switch no longer returns to Auto, so it is possible to drive at night with only DRLs and no tail lights.',
    on: ['726-74-01 xx01 xxxx xx--'], off: ['726-74-01 xx00 xxxx xx--'] },
  { id: 'p-auto-relock', src: 'auto-relock-2021', name: 'Relock automatically if no door is opened after unlocking',
    on: ['726-20-01 x1x1 x1x1 x1--', '726-27-01 xxxx xxxx x1--'] },
  { id: 'p-car-finder', src: 'keyfob-car-finder', name: 'Horn chirp on the second lock press',
    on: ['726-24-02 xxxx xxxx 01--'], off: ['726-24-02 xxxx xxxx 00--'] },
  { id: 'p-panic-button', src: 'keyfob-panic-button', name: 'Key fob panic button',
    choices: [['One press (factory default)', '726-62-01 x2xx xxxx xx--'], ['Needs two presses', '726-62-01 x1xx xxxx xx--'], ['Disabled', '726-62-01 x0xx xxxx xx--']] },
  { id: 'p-panic-lights', src: 'keyfob-panic-lights-only', name: 'Panic alarm flashes lights only, no horn',
    on: ['726-01-02 xxxx xxx1 xx--'], off: ['726-01-02 xxxx xxx0 xx--'] },
  { id: 'p-tailgate-fob', src: 'keyfob-tailgate-release-disable', name: 'Disable tailgate release from the key fob',
    on: ['726-61-01 xxxx xxxx 00--'] },
  { id: 'p-power-point', src: 'power-point-timeout', name: 'Keep 12 V power points on after shutdown', risk: 'medium',
    note: 'Can drain the battery. The 400 W outlet still will not run with the engine off.',
    on: ['726-57-01 xxxx 00xx xx--'], off: ['726-57-01 xxxx 01xx xx--'] },
  { id: 'p-global-windows', src: 'global-windows-2021', name: 'Open and close the front windows from the key fob', risk: 'medium',
    note: 'Changes the body module and both front door modules.',
    on: ['726-11-02 xx01 xx01 xx--', '726-22-01 xxxx xxxx 01--', '726-22-02 xxxx xxxx 01--',
      '740-06-02 xxxx xxxx 01--', '740-06-03 01xx xxxx xx--', '741-06-02 xxxx xxxx 01--', '741-06-03 01xx xxxx xx--'] },
  { id: 'p-front-outage', src: 'front-turn-outage-off', name: 'Turn off front turn-signal bulb-out detection (LED swap)',
    note: 'Only for LED bulb retrofits. You will no longer be warned of a failed front turn bulb.',
    on: ['726-40-02 00xx xxxx xx--'], off: ['726-40-02 01xx xxxx xx--'] },
  { id: 'p-rear-outage', src: 'rear-turn-outage-off', name: 'Turn off rear turn-signal bulb-out detection (LED swap)',
    note: 'Only for LED tail lamp retrofits. You will no longer be warned of a failed rear turn bulb.',
    on: ['726-44-02 00xx xxxx xx--'] },
  { id: 'p-keypad', src: 'keypad-enable', name: 'Enable a retrofitted door keypad',
    note: 'Needs the keypad hardware installed.',
    on: ['726-31-01 xxxx xx01 xx--'] },
  { id: 'p-tow-markers', src: 'tow-mirror-upgrade', name: 'Tow-mirror marker lamps',
    note: 'Needs factory tow mirrors installed.',
    on: ['726-40-01 xxxx xxx1 xx--'] },

  /* Doors, steering column, audio */
  { id: 'p-tow-turn', src: 'tow-mirror-upgrade', name: 'Tow-mirror side turn lamps',
    note: 'Needs factory tow mirrors installed. Changes both front door modules.',
    on: ['740-03-04 xxxx x1xx xx--', '741-03-04 xxxx x1xx xx--'] },
  { id: 'p-autofold', src: 'lincoln-autofold-mirrors', name: 'Mirrors fold on lock and unfold when the driver door closes',
    note: 'Needs power-folding mirrors. The puddle lights stop working with this on.',
    on: ['740-03-16 xxxx xxxx 01--', '741-03-16 xxxx xxxx 01--', '7D0-09-01 xxxx xxAx xx--'] },
  { id: 'p-tap-count', src: 'turn-signal-tap-count', name: 'Lane-change turn signal flashes',
    choices: [
      ['3 flashes (factory default)', { loc: '724-01-01', byte: 2, mask: 0x1C, value: 0x0C }],
      ['4 flashes', { loc: '724-01-01', byte: 2, mask: 0x1C, value: 0x10 }],
      ['5 flashes', { loc: '724-01-01', byte: 2, mask: 0x1C, value: 0x14 }]] },
  { id: 'p-heated-wheel', src: 'heated-wheel-temp', name: 'Heated steering wheel temperature',
    note: 'Trucks with a heated steering wheel.',
    choices: [['32 °C', '724-06-01 8xxx xxxx xx--'], ['35 °C (factory default)', '724-06-01 Bxxx xxxx xx--'], ['39 °C', '724-06-01 Fxxx xxxx xx--']] },
  { id: 'p-ese', src: 'disable-engine-sound-enhancement', name: 'Turn off in-cabin engine sound enhancement',
    note: 'The same digit may also affect active noise cancellation.',
    on: ['727-01-01 xxxx xxxx 0x--'] },
];

const PRESET_SOURCE = 'https://f150mods.us/mods/';
