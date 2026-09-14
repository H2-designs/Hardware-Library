// Forensics: WHO turns a device's remote logging on/off?
// Correlates, with timestamps, on one device:
//   - every command published to its passthrough topic (dashboard / MQTT Explorer / anyone)
//   - the device's own "[mdb] MQTT log publishing enabled/disabled" lines (emitted whenever
//     setMqttLogging() runs - from a remote command OR from the app's own code)
//   - every SETTINGS_JSON mqttLogsEnabled value
//   - status online/offline and the auto-attach line (= app restart markers)
// A "publishing enabled" line with NO preceding passthrough setMqttLogging:on within ~2 s means
// the APP's own code called HardwareLib.setMqttLogging(true).
// Usage: node who-flips-logs.js D-0416 [hours]
const fs = require('fs');
const props = fs.readFileSync('C:/Users/Hamdan/Desktop/MVP/MdbSlaveApp/local.properties', 'utf8');
const get = (k) => (props.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
const dev = process.argv[2] || 'D-0416';
const hours = Number(process.argv[3] || 6);
const mqtt = require('mqtt');
const c = mqtt.connect('mqtt://' + get('mqttHost') + ':' + get('mqttPort'),
  { username: get('mqttUsername'), password: get('mqttPassword') });
const log = (s) => console.log(new Date().toISOString() + ' ' + s);
let lastRemoteLogCmdAt = 0;
c.on('connect', () => {
  log('forensics on ' + dev + ' for ' + hours + 'h');
  c.subscribe('devices/' + dev + '/passthrough');
  c.subscribe('devices/' + dev + '/cmd');
  c.subscribe('devices/' + dev + '/logs');
  c.subscribe('devices/' + dev + '/status');
  setTimeout(() => { log('done (' + hours + 'h)'); process.exit(0); }, hours * 3600 * 1000);
});
c.on('error', (e) => log('mqtt error ' + e.message));
c.on('message', (t, p) => {
  const s = p.toString().trim();
  const leaf = t.split('/').slice(2).join('/');
  if (leaf === 'passthrough' || leaf === 'cmd') {
    log('CMD via ' + leaf + ': ' + s.slice(0, 80));
    if (/setMqttLogging/i.test(s)) lastRemoteLogCmdAt = Date.now();
    return;
  }
  if (leaf === 'status') { log('STATUS ' + s); return; }
  if (s.includes('MQTT log publishing')) {
    const remote = Date.now() - lastRemoteLogCmdAt < 2500;
    log('DEVICE: ' + s + (remote ? '   [caused by a remote command above]' : '   [NO remote command - the APP CODE called setMqttLogging]'));
    return;
  }
  if (s.includes('attached to mqtt-lib')) { log('DEVICE: auto-attach (app start/reconnect)'); return; }
  const m = s.match(/mqttLogsEnabled":(true|false)/);
  if (m) log('SETTINGS_JSON mqttLogsEnabled=' + m[1]);
  if (s.startsWith('[remote] mqtt-lib')) log('DEVICE: ' + s);
});
