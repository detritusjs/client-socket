class Bucket {
	constructor(limit, delay) {
		this.limit = limit;
		this.delay = delay;

		this.sent = {
			amount: 0,
			reset: 0
		};

		this.queue = [];

		this.locked = false;
		this.unlockTimer = null;
	}

	clear() {
		this.queue.length = 0;
	}

	lock(unlockIn) {
		if (this.locked && this.unlockTimer) {
			clearTimeout(this.unlockTimer);
			this.unlockTimer = null;
		}
		this.locked = true;
		if (unlockIn) {
			this.unlockTimer = setTimeout(this.unlock.bind(this), unlockIn);
		}
	}

	unlock() {
		this.locked = false;
		this.shift();
	}

	add(func, unshift) {
		if (unshift) {
			this.queue.unshift(func);
		} else {
			this.queue.push(func);
		}
		this.shift();
	}

	shift() {
		if (this.locked) {return;}
		if (!this.queue.length) {return;}

		if (this.limit) {
			if (Date.now() >= this.sent.reset + this.delay) {
				this.sent.reset = Date.now();
				this.sent.amount = 0;
			}
			if (++this.sent.amount >= this.limit) {
				const diff = Math.max(this.delay - (Date.now() - this.sent.reset), 0);
				if (diff) {
					this.lock(diff);
				}
			}
		}

		const func = this.queue.shift();
		if (!func) {return;}
		func();
		this.shift();
	}
}

module.exports = Bucket;