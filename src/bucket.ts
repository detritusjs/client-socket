import { Timers } from 'detritus-utils';


export class Bucket {
  // called for a queued item that gets cleared instead of run
  readonly drops = new Map<Function, Function>();
  readonly resetTimeout = new Timers.Timeout();
  readonly timeout = new Timers.Timeout();

  delay: number;
  limit: number;
  locked: boolean;
  priority: Array<Function>;
  queue: Array<Function>;
  reserved: number;
  // ring of the last `limit` send times, `sentIndex` is the oldest one
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
      drops: {enumerable: false},
      resetTimeout: {enumerable: false},
      timeout: {enumerable: false},
    });
  }

  add(
    throttled: Function,
    unshift: boolean = false,
    onDrop?: Function,
  ): void {
    if (onDrop) {
      this.drops.set(throttled, onDrop);
    }
    if (unshift) {
      this.queue.unshift(throttled);
    } else {
      this.queue.push(throttled);
    }
    this.shift();
  }

  // priority items go before the queue, ignore `locked`, and may use the `reserved` slots
  addPriority(throttled: Function, onDrop?: Function): void {
    if (onDrop) {
      this.drops.set(throttled, onDrop);
    }
    this.priority.push(throttled);
    this.shift();
  }

  clear(): void {
    const dropped = this.priority.concat(this.queue);
    this.priority.length = 0;
    this.queue.length = 0;
    this.drop(dropped);
  }

  clearPriority(): void {
    const dropped = this.priority.slice();
    this.priority.length = 0;
    this.drop(dropped);
  }

  protected drop(dropped: Array<Function>): void {
    for (let throttled of dropped) {
      const onDrop = this.drops.get(throttled);
      if (onDrop) {
        this.drops.delete(throttled);
        onDrop();
      }
    }
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

  // for when the limit starts over, like a new connection
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
        // it runs now, if it queues itself again it passes its `onDrop` again
        this.drops.delete(throttled);
        throttled();
      }
    }
  }

  unlock(): void {
    this.locked = false;
    this.shift();
  }
}
