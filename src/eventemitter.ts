let Emitter: any = require('events').EventEmitter;
try {
  Emitter = require('eventemitter3');
} catch(e) {}
export default Emitter;
