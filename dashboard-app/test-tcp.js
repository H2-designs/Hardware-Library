// Smoke test: prove the mqtt package reaches the broker over plain TCP with the same
// credentials the device uses (read from the app project's local.properties - not stored here).
const fs = require('fs');
const props = fs.readFileSync('C:/Users/Hamdan/Desktop/MVP/MdbSlaveApp/local.properties', 'utf8');
const get = (k) => (props.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
const mqtt = require('mqtt');
const url = 'mqtt://' + get('mqttHost') + ':' + get('mqttPort');
console.log('connecting to ' + url + ' as ' + get('mqttUsername'));
const c = mqtt.connect(url, { username: get('mqttUsername'), password: get('mqttPassword'), connectTimeout: 8000 });
const bail = setTimeout(() => { console.log('TIMEOUT - no connack in 10s'); process.exit(1); }, 10000);
c.on('connect', () => {
  console.log('CONNECTED over TCP');
  c.subscribe('cm30-mdb/hamdan-rabbah/#', (err) => {
    console.log(err ? 'subscribe error: ' + err.message : 'SUBSCRIBED to cm30-mdb/hamdan-rabbah/#');
    clearTimeout(bail);
    // listen briefly in case a device is talking right now
    setTimeout(() => { c.end(true); process.exit(0); }, 4000);
  });
});
c.on('message', (t, p) => console.log('rx ' + t + ' :: ' + p.toString().slice(0, 80)));
c.on('error', (e) => { console.log('ERROR: ' + e.message); clearTimeout(bail); process.exit(1); });
