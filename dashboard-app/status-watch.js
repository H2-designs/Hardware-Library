// Long-running online/offline flap monitor: logs every status transition with timing,
// prints a per-device summary at the end. Usage: node status-watch.js [hours]
const fs = require('fs');
const props = fs.readFileSync('C:/Users/Hamdan/Desktop/MVP/MdbSlaveApp/local.properties', 'utf8');
const get = (k) => (props.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
const hours = Number(process.argv[2] || 6);
const mqtt = require('mqtt');
const c = mqtt.connect('mqtt://' + get('mqttHost') + ':' + get('mqttPort'),
  { username: get('mqttUsername'), password: get('mqttPassword') });
const last = {}; const flips = {};
const log = (s) => console.log(new Date().toISOString() + ' ' + s);
c.on('connect', () => {
  log('watching devices/+/status for ' + hours + 'h');
  c.subscribe('devices/+/status');
});
c.on('error', (e) => log('mqtt error: ' + e.message));
c.on('message', (t, p) => {
  const id = t.split('/')[1]; const s = p.toString().trim(); const now = Date.now();
  if (last[id] && last[id].s !== s) {
    const gap = ((now - last[id].t) / 1000).toFixed(1);
    flips[id] = (flips[id] || 0) + 1;
    log(id + ' -> ' + s + ' (was ' + last[id].s + ' for ' + gap + 's)  [flip #' + flips[id] + ']');
  }
  last[id] = { s: s, t: now };
});
setTimeout(() => {
  log('--- SUMMARY after ' + hours + 'h ---');
  const rows = Object.entries(flips).sort((a, b) => b[1] - a[1]);
  if (!rows.length) log('no transitions at all - fleet was stable');
  rows.forEach(([id, n]) => log(id + ': ' + n + ' transitions'));
  process.exit(0);
}, hours * 3600 * 1000);
