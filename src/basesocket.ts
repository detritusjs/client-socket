import { BaseCollection, EventSpewer, Timers } from 'detritus-utils';

import {
  SocketCloseCodes,
  SocketEventsBase,
} from './constants';

export const DependencyTypes = Object.freeze({
  UWS: 'uws',
  WS: 'ws',
});

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

export class BaseSocket extends EventSpewer {
  readonly pings = new BaseCollection<string, {
    reject: Function,
    resolve: Function,
  }>();

  socket: any;

  constructor(url: string) {
    super();
    this.socket = new WebsocketDependency.module(url);
    this.socket.on(SocketEventsBase.PONG, this.onPong.bind(this));

    for (let event of Object.values(SocketEventsBase)) {
      if (event === SocketEventsBase.PONG) {
        continue;
      }
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
    code: number = SocketCloseCodes.NORMAL,
    reason: string = '',
  ): void {
    if (this.connected) {
      this.socket.close(code, reason);
    }
    for (const [nonce, {reject}] of this.pings) {
      reject(new Error('Socket has closed.'));
      this.pings.delete(nonce);
    }
    this.pings.clear();
    this.socket.removeAllListeners();
    this.removeAllListeners();
  }

  onPong(data: any): void {
    try {
      const { nonce } = JSON.parse(String(data));
      const ping = this.pings.get(nonce);
      if (ping) {
        ping.resolve();
        this.pings.delete(nonce);
      }
    } catch(e) {
      // malformed ping?
    }
    this.emit(SocketEventsBase.PONG, data);
  }

  async ping(
    timeout: number = 1000,
  ): Promise<number> {
    if (!this.connected) {
      throw new Error('Socket isn\'t connected.');
    }
    const nonce = `${Date.now()}.${Math.random().toString(36)}`;
    return new Promise((resolve, reject) => {
      const expire = new Timers.Timeout();
      if (timeout) {
        expire.start(timeout, () => {
          this.pings.delete(nonce);
          reject(new Error(`Pong took longer than ${timeout}ms.`));
        });
      }

      const now = Date.now();
      new Promise((res, rej) => {
        this.pings.set(nonce, {
          resolve: res,
          reject: rej,
        });
        this.socket.ping(JSON.stringify({nonce}));
      }).then(() => {
        expire.stop();
        resolve(Math.round(Date.now() - now));
      });
    });
  }
}
