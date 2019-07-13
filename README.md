# websocket
a low level wrapper over discord's gateway and voice websocket

## usage
```js
const Detritus = require('./websocket/lib/index.js');
const fs = require('fs');

console.log(process.env.TOKEN);

const client = new Detritus.Gateway(process.env.TOKEN, {
    encoding: 'etf',
    compress: false,
});

const url = 'wss://gateway.discord.gg/';
client.connect(url);
client.on('ready', () => console.log('ready'));

const writeCallback = (e) => {
    if (e) {
        console.error(e);
    }
}

client.on('packet', w => {
    const data = w.data;
    const packet = w.packet;

    if (packet.op != 0) {
        return;
    }

    const file = `dump/${packet.t}`;
    fs.access(file + '.etf', fs.constants.F_OK, (err) => {
        // file exists
        if (!err) {
            return;
        }

        fs.writeFile(file + '.etf', data, writeCallback);
        fs.writeFile(file + '.json', JSON.stringify(packet), writeCallback);
        console.log('wrote ' + file);
    });
});
client.on('open', (event) => console.log('client open', event));
client.on('close', (event) => console.log('client close', event));
client.on('error', console.log);
```
