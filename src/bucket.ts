import { Timers } from 'detritus-utils';


export class Bucket {
  readonly resetTimeout = new Timers.Timeout();
  readonly timeout = new Timers.Timeout();

  delay: number;
  limit: number;
  locked: boolean;
  priority: Array<Function>;
  queue: Array<Function>;
  reserved: number;
  sent: {
    amount: number,
    reset: number,
  };

  constructor(
    limit: number = 0,
    delay: number = 0,
    reserved: number = 0,
  ) {
    this.delay = delay;
    this.limit = limit;
    this.locked = false;
    this.priority = [];
    this.queue = [];
    this.reserved = reserved;
    this.sent = {
      amount: 0,
      reset: 0,
    };

    Object.defineProperties(this, {
      resetTimeout: {enumerable: false},
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

  // priority items go before the queue, ignore `locked`, and may use the `reserved` slots
  addPriority(throttled: Function): void {
    this.priority.push(throttled);
    this.shift();
  }

  clear(): void {
    this.priority.length = 0;
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
    while (this.priority.length || (!this.locked && this.queue.length)) {
      const isPriority = !!this.priority.length;
      if (this.limit) {
        const now = Date.now();
        if (this.sent.reset + this.delay <= now) {
          this.sent.reset = now;
          this.sent.amount = 0;
        }

        const limit = (isPriority) ? this.limit : Math.max(this.limit - this.reserved, 0);
        if (limit <= this.sent.amount) {
          // wait for the window to reset, keeping an already scheduled wakeup
          this.resetTimeout.start(this.sent.reset + this.delay - now, () => {
            this.shift();
          }, false);
          return;
        }
        this.sent.amount++;
      }

      const throttled = (isPriority) ? this.priority.shift() : this.queue.shift();
      if (throttled) {
        throttled();
      }
    }
  }

  unlock(): void {
    this.locked = false;
    this.shift();
  }
}
