// Live diagnosis for one fleet device: watch ALL its topics, poke its passthrough
// (correct spelling AND the historical misspelling), print everything that comes back.
const fs = require('fs');
const props = fs.readFileSync('C:/Users/Hamdan/Desktop/MVP/MdbSlaveApp/local.properties', 'utf8');
const get = (k) => (props.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
const dev = process.argv[2] || 'D-5007';
const mqtt = require('mqtt');
const c = mqtt.connect('mqtt://' + get('mqttHost') + ':' + get('mqttPort'),
  { username: get('mqttUsername'), password: get('mqttPassword'), connectTimeout: 8000 });
c.on('connect', () => {
  console.log('connected; watching devices/' + dev + '/#');
  c.subscribe('devices/' + dev + '/#', () => {
    const steps = [
      ['devices/' + dev + '/passthrough', 'help'],
      ['devices/' + dev + '/passthrough', 'getRs232Rules'],
      ['devices/' + dev + '/passtrough', 'help'],          // historical misspelling test
      ['devices/' + dev + '/cmd', 'help'],                 // maybe wired into cmd instead
    ];
    let i = 0;
    const next = () => {
      if (i >= steps.length) return;
      console.log('>> ' + steps[i][0].split('/').pop() + ' <- ' + steps[i][1]);
      c.publish(steps[i][0], steps[i][1]);
      i++;
      setTimeout(next, 3000);
    };
    setTimeout(next, 800);
  });
  setTimeout(() => { console.log('--- done ---'); c.end(true); process.exit(0); }, 16000);
});
c.on('message', (t, p) => {
  const s = p.toString();
  console.log('<< [' + t.split('/').slice(2).join('/') + '] ' + s.slice(0, 160));
});
c.on('error', (e) => { console.log('ERROR ' + e.message); process.exit(1); });
