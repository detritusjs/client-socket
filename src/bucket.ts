import { Timers } from 'detritus-utils';


export class Bucket {
  readonly timeout = new Timers.Timeout();

  delay: number;
  limit: number;
  locked: boolean;
  queue: Array<any>;
  sent: {
    amount: number,
    reset: number,
  };

  constructor(
    limit: number = 0,
    delay: number = 0,
  ) {
    this.delay = delay;
    this.limit = limit;
    this.locked = false;
    this.queue = [];
    this.sent = {
      amount: 0,
      reset: 0,
    };

    Object.defineProperties(this, {
      timeout: {enumerable: false},
    });
  }

  add(
    throttled: Function,
    unshift: boolean = false,
  ): void {
    if (unshift) {
      this.queue.unshift(throttled);
    } else {
      this.queue.push(throttled);
    }
    this.shift();
  }

  clear(): void {
    this.queue.length = 0;
  }

  lock(unlockIn: number = 0): void {
    this.timeout.stop();

    this.locked = true;
    if (unlockIn) {
      this.timeout.start(unlockIn, () => {
        this.unlock();
      });
    }
  }

  shift(): void {
    if (this.locked) {return;}
    if (!this.queue.length) {return;}

    if (this.limit) {
      const now = Date.now();
      if (this.sent.reset + this.delay <= now) {
        this.sent.reset = now;
        this.sent.amount = 0;
      }
      if (this.limit <= ++this.sent.amount) {
        const diff = Math.max(this.delay - (now - this.sent.reset), 0);
        if (diff) {
          this.lock(diff);
        }
      }
    }

    const throttled = this.queue.shift();
    if (throttled) {
      throttled();
      this.shift();
    }
  }

  unlock(): void {
    this.locked = false;
    this.shift();
  }
}
