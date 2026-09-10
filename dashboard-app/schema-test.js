// End-to-end RS232 schema test: subscribe to the device's log topic, drive it over its
// passthrough topic, and print every RABBAH_LOG envelope that comes back - we expect
// coded items with "s":"RS232". Credentials read from local.properties, device id as argv[2].
const fs = require('fs');
const props = fs.readFileSync('C:/Users/Hamdan/Desktop/MVP/MdbSlaveApp/local.properties', 'utf8');
const get = (k) => (props.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
const dev = process.argv[2];
if (!dev) { console.log('usage: node schema-test.js <deviceId>'); process.exit(1); }
const mqtt = require('mqtt');
const c = mqtt.connect('mqtt://' + get('mqttHost') + ':' + get('mqttPort'),
  { username: get('mqttUsername'), password: get('mqttPassword'), connectTimeout: 8000 });
const logT = 'devices/' + dev + '/logs';
const ptT = 'devices/' + dev + '/passthrough';
c.on('connect', () => {
  console.log('connected; watching ' + logT);
  c.subscribe(logT, () => {
    const cmds = [
      '{"setRs232Rules":[{"name":"HEARTBEAT","rx":"A0 06 00 02 48 42 ??","tx":"A1 06 00 02 4F 4B A1"},{"name":"PAYMENT","rx":"A0 01 *","tx":"","amountStart":4,"amountEnd":-1}]}',
      'rs232Crc:on',
      'rs232Simulate:A0 06 00 02 48 42 AE',
      'rs232Simulate:A0 01 00 03 30 30 36 94',
      'rs232Simulate:A0 36',
    ];
    let i = 0;
    const next = () => {
      if (i >= cmds.length) return;
      console.log('>> pt: ' + cmds[i].slice(0, 60));
      c.publish(ptT, cmds[i++]);
      setTimeout(next, 1200);
    };
    setTimeout(next, 500);
  });
  setTimeout(() => { c.end(true); process.exit(0); }, 10000);
});
c.on('message', (t, p) => {
  const s = p.toString();
  if (s.startsWith('RABBAH_LOG:')) {
    try {
      const j = JSON.parse(s.slice('RABBAH_LOG:'.length));
      console.log('<< item  s=' + j.s + ' m=' + j.m + ' p=[' + (j.p || []).join(' | ') + ']');
    } catch (_) { console.log('<< ' + s.slice(0, 100)); }
  } else {
    console.log('<< raw   ' + s.slice(0, 110));
  }
});
c.on('error', (e) => { console.log('ERROR ' + e.message); process.exit(1); });
