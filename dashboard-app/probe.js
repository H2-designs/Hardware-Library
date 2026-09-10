// Diagnostic: connect over TCP with the device credentials (read from local.properties,
// not stored here), subscribe to EVERYTHING, and print every topic seen for 15 seconds -
// shows whether any device is publishing and on WHICH topic names.
const fs = require('fs');
const props = fs.readFileSync('C:/Users/Hamdan/Desktop/MVP/MdbSlaveApp/local.properties', 'utf8');
const get = (k) => (props.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
const mqtt = require('mqtt');
const url = 'mqtt://' + get('mqttHost') + ':' + get('mqttPort');
console.log('connecting to ' + url);
const c = mqtt.connect(url, { username: get('mqttUsername'), password: get('mqttPassword'), connectTimeout: 8000 });
const seen = {};
c.on('connect', () => {
  console.log('CONNECTED');
  c.subscribe('#', (err) => console.log(err ? 'subscribe # error: ' + err.message : 'subscribed to # (everything)'));
  setTimeout(() => {
    console.log('--- topics seen in 15s ---');
    const keys = Object.keys(seen);
    if (keys.length === 0) console.log('(nothing at all - no device is publishing right now)');
    for (const t of keys) console.log(t + '  (' + seen[t].n + ' msgs)  last: ' + seen[t].last.slice(0, 90));
    c.end(true); process.exit(0);
  }, 15000);
});
c.on('message', (t, p) => { const e = seen[t] = seen[t] || { n: 0, last: '' }; e.n++; e.last = p.toString(); });
c.on('error', (e) => { console.log('ERROR: ' + e.message); process.exit(1); });
