// Watch D-5007 until the mqtt-lib 2.5.2 build is deployed, then verify the full loop.
// Probes 'version' every 10 min (one log line per probe); exits on success or after maxHours.
const fs = require('fs');
const props = fs.readFileSync('C:/Users/Hamdan/Desktop/MVP/MdbSlaveApp/local.properties', 'utf8');
const get = (k) => (props.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
const dev = process.argv[2] || 'D-5007';
const maxHours = Number(process.argv[3] || 24);
const mqtt = require('mqtt');
const c = mqtt.connect('mqtt://' + get('mqttHost') + ':' + get('mqttPort'),
  { username: get('mqttUsername'), password: get('mqttPassword') });
const log = (s) => console.log(new Date().toISOString() + ' ' + s);
let phase = 'watch'; // watch -> verify -> done
c.on('connect', () => {
  log('connected, watching ' + dev + ' for mqtt-lib 2.5.2');
  c.subscribe('devices/' + dev + '/logs');
  probe();
  setInterval(probe, 10 * 60 * 1000);
  setTimeout(() => { log('TIMEOUT: 2.3.0 not seen within ' + maxHours + 'h'); process.exit(2); },
    maxHours * 3600 * 1000);
});
function probe() {
  if (phase !== 'watch') return;
  c.publish('devices/' + dev + '/passthrough', 'version');
}
c.on('message', (t, p) => {
  const s = p.toString();
  if (phase === 'watch' && s.includes('mqtt-lib 2.5.2')) {
    phase = 'verify';
    log('NEW BUILD DETECTED: ' + s);
    log('verifying: help ...');
    c.publish('devices/' + dev + '/passthrough', 'help');
    setTimeout(() => {
      log('verifying: getSettings ...');
      c.publish('devices/' + dev + '/passthrough', 'getSettings');
    }, 3000);
    setTimeout(() => { log('VERIFICATION WINDOW CLOSED - see replies above'); process.exit(0); }, 12000);
    return;
  }
  if (phase === 'verify') log('<< ' + s.slice(0, 300));
});
c.on('error', (e) => log('mqtt error: ' + e.message));
