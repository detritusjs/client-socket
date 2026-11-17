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
  // ring of the last `limit` send times, `sentIndex` is the oldest one (and the next one to overwrite)
  sent: Array<number>;
  sentIndex: number;

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
    this.sent = new Array(limit).fill(0);
    this.sentIndex = 0;

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

  clearPriority(): void {
    this.priority.length = 0;
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

  // forgets the past sends, for when the limit starts over (like a new connection)
  reset(): void {
    this.resetTimeout.stop();
    this.sent.fill(0);
    this.sentIndex = 0;
    this.shift();
  }

  shift(): void {
    while (this.priority.length || (!this.locked && this.queue.length)) {
      const isPriority = !!this.priority.length;
      if (this.limit) {
        if (this.sent.length !== this.limit) {
          // `limit` was changed, start the window over
          this.sent = new Array(this.limit).fill(0);
          this.sentIndex = 0;
        }

        // sliding window, we can send once the `limit`th most recent send is at least `delay` old
        const limit = (isPriority) ? this.limit : Math.max(this.limit - this.reserved, 0);
        if (!limit) {
          return;
        }
        const now = Date.now();
        const sentAt = this.sent[(this.sentIndex + this.limit - limit) % this.limit];
        if (now < sentAt + this.delay) {
          this.resetTimeout.start(sentAt + this.delay - now, () => {
            this.shift();
          });
          return;
        }
        this.sent[this.sentIndex] = now;
        this.sentIndex = (this.sentIndex + 1) % this.limit;
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
