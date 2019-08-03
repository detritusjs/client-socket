import EventEmitter from './eventemitter';
import { SocketCloseCodes } from './constants';

export const DependencyTypes = Object.freeze({
  UWS: 'uws',
  WS: 'ws',
});

export const WebsocketEvents = {
  CLOSE: 'close',
  ERROR: 'error',
  MESSAGE: 'message',
  OPEN: 'open',
  PING: 'ping',
  PONG: 'pong',
  UNEXPECTED_RESPONSE: 'unexpected-response',
  UPGRADE: 'upgrade',
};

export const WebsocketDependency: {
  module: any,
  type: string,
} = {
  module: null,
  type: '',
};

[
  DependencyTypes.WS,
  DependencyTypes.UWS,
].forEach((dependency) => {
  try {
    WebsocketDependency.module = require(dependency);
    WebsocketDependency.type = dependency;
  } catch(e) {}
});

if (WebsocketDependency.module === null) {
  throw new Error(`Missing a WebSocket Dependency, pick one: ${JSON.stringify(Object.values(DependencyTypes))}`)
}

export class BaseSocket extends EventEmitter {
  socket: any;
  pings: Map<string, {
    reject: Function,
    resolve: Function,
  }>;

  constructor(url: string) {
    super();
    this.socket = new WebsocketDependency.module(url);
    this.pings = new Map();

    this.socket.on('pong', (data: any) => {
      try {
        const {nonce} = JSON.parse(String(data));
        const ping = this.pings.get(nonce);
        if (ping) {
          ping.resolve();
          this.pings.delete(nonce);
        }
      } catch(e) {
        // malformed ping?
      }
    });

    for (let event of Object.values(WebsocketEvents)) {
      this.socket.on(event, this.emit.bind(this, event));
    }
  }

  get closed(): boolean {
    return this.socket.readyState === this.socket.CLOSED;
  }

  get closing(): boolean {
    return this.socket.readyState === this.socket.CLOSING;
  }

  get connected(): boolean {
    return this.socket.readyState === this.socket.OPEN;
  }

  get connecting(): boolean {
    return this.socket.readyState === this.socket.CONNECTING;
  }

  get using(): string {
    return WebsocketDependency.type;
  }

  send(
    data: any,
    callback?: Function,
  ): void {
    if (this.connected) {
      this.socket.send(data, {}, callback);
    }
  }

  close(
    code: number | string = SocketCloseCodes.NORMAL,
    reason: string = '',
  ): void {
    if (this.connected) {
      this.socket.close(code, reason);
      for (let {reject} of this.pings.values()) {
        reject(new Error('Socket has closed.'));
      }
      this.pings.clear();
    }
  }

  async ping(
    timeout: number = 1000,
  ): Promise<any> {
    if (!this.connected) {
      throw new Error('Socket isn\'t connected.');
    }
    const nonce = `${Date.now()}.${Math.random().toString(36)}`;
    return new Promise((resolve, reject) => {
      let expire: ReturnType<typeof setTimeout>;
      if (timeout) {
        expire = setTimeout(() => {
          this.pings.delete(nonce);
          reject(new Error(`Pong took longer than ${timeout}ms.`));
        }, timeout);
      }
      const now = Date.now();
      new Promise((res, rej) => {
        this.pings.set(nonce, {
          resolve: res,
          reject: rej,
        });
        this.socket.ping(JSON.stringify({nonce}));
      }).then(() => {
        if (expire !== undefined) {
          clearTimeout(<number> <unknown> expire);
        }
        resolve(Math.round(Date.now() - now));
      });
    });
  }
}