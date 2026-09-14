// Waits for a device to go offline->online (app restart / reconnect), then reads its settings
// to prove which values persisted across the restart. Usage: node restart-check.js D-0416 [hours]
const fs = require('fs');
const props = fs.readFileSync('C:/Users/Hamdan/Desktop/MVP/MdbSlaveApp/local.properties', 'utf8');
const get = (k) => (props.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
const dev = process.argv[2] || 'D-0416';
const hours = Number(process.argv[3] || 12);
const mqtt = require('mqtt');
const c = mqtt.connect('mqtt://' + get('mqttHost') + ':' + get('mqttPort'),
  { username: get('mqttUsername'), password: get('mqttPassword') });
const log = (s) => console.log(new Date().toISOString() + ' ' + s);
let sawOffline = false;
c.on('connect', () => {
  log('waiting for ' + dev + ' to restart (offline -> online)...');
  c.subscribe('devices/' + dev + '/status');
  c.subscribe('devices/' + dev + '/logs');
  setTimeout(() => { log('TIMEOUT - no restart seen in ' + hours + 'h'); process.exit(2); }, hours * 3600 * 1000);
});
c.on('message', (t, p) => {
  const s = p.toString().trim();
  if (t.endsWith('/status')) {
    if (s === 'offline') { sawOffline = true; log(dev + ' went OFFLINE'); }
    else if (s === 'online' && sawOffline) {
      log(dev + ' back ONLINE - reading settings after restart...');
      setTimeout(() => c.publish('devices/' + dev + '/passthrough', 'getSettings'), 4000);
      setTimeout(() => c.publish('devices/' + dev + '/passthrough', 'version'), 6000);
      setTimeout(() => { log('done'); process.exit(0); }, 10000);
    }
    return;
  }
  if (s.includes('attached to mqtt-lib')) log('device says: ' + s);
  const m = s.match(/mqttLogsEnabled":(true|false)/);
  if (m) log('AFTER RESTART: mqttLogsEnabled = ' + m[1] + (m[1] === 'false' ? '  <- PERSISTED (correct)' : '  <- RESET TO ON (app or lib turning it back on)'));
  if (s.startsWith('[remote] mqtt-lib')) log('AFTER RESTART: ' + s);
});
