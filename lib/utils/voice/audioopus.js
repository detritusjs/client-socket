const OpusSettings = require('../constants').Opus;

const Opus = {
	available: {},
	modules: ['node-opus', 'opusscript']
};

for (let mod of Opus.modules) {
	try {
		Opus.available[mod] = require(mod);
	} catch (e) {continue;}
}

const defaults = {
	application: OpusSettings.Applications.AUDIO
};

class AudioOpus {
	constructor(sampleRate, channels, options) {
		options = Object.assign({}, defaults, options);

		Object.defineProperty(this, 'opus', {configurable: true, value: null});

		Object.defineProperties(this, {
			sampleRate: {enumerable: true, configurable: true, value: null},
			channels: {enumerable: true, configurable: true, value: null},
			application: {enumerable: true, configurable: true, value: null},
			mod: {enumerable: true, configurable: true, value: null}
		});

		this.setSampleRate(sampleRate);
		this.setChannels(channels);
		this.setApplication(options.application);
		this.setMod(options.mod || Opus.modules.find((m) => m in Opus.available));
		this.recreate();
	}

	get module() {
		if (!this.mod) {throw new Error('Module missing, cannot opus encode/decode.');}
		return Opus.available[this.mod];
	}

	get enabled() {
		return !!this.opus;
	}

	recreate() {
		if (!this.mod) {
			throw new Error('Module missing, set one using setMod');
		}
		if (!this.sampleRate) {
			throw new Error('Cannot create an Opus object without a sampleRate setting!');
		}
		if (!this.channels) {
			throw new Error('Cannot create an Opus object without a channels setting!');
		}
		if (!this.application) {
			throw new Error('Cannto create an Opus object without an application setting!');
		}

		if (this.enabled) {
			this.delete();
		}

		let opus;
		switch(this.mod) {
			case 'node-opus': {
				opus = new this.module.OpusEncoder(this.sampleRate, this.channels, this.application);
			}; break;
			case 'opusscript': {
				opus = new this.module(this.sampleRate, this.channels, this.application);
			}; break;
		}

		return Object.defineProperty(this, 'opus', {value: opus});
	}

	setSampleRate(sampleRate) {
		if (!OpusSettings.SAMPLE_RATES.includes(sampleRate)) {
			throw new Error(`Invalid Sample Rate provided, please choose one of: ${JSON.stringify(OpusSettings.SAMPLE_RATES)}`);
		}

		Object.defineProperty(this, 'sampleRate', {value: sampleRate});
		return (this.enabled) ? this.recreate() : this;
	}

	setChannels(channels) {
		Object.defineProperty(this, 'channels', {value: +channels});
		return (this.enabled) ? this.recreate() : this;
	}

	setApplication(application) {
		Object.defineProperty(this, 'application', {value: +application});
		return (this.enabled) ? this.recreate() : this;
	}

	setMod(mod) {
		if (!mod && this.mod) {
			mod = this.mod;
		}
		if (!mod) {
			throw new Error(`For opus encoding/decoding, please install one of: ${JSON.stringify(Opus.modules)}`);
		}
		if (!Opus.modules.includes(mod)) {
			throw new Error(`Invalid module '${mod}', please use one of: ${JSON.stringify(Opus.modules)}`);
		}
		if (!(mod in Opus.available)) {
			throw new Error(`Module '${mod}' is not installed, use one of: ${JSON.stringify(Opus.modules)}`);
		}

		return Object.defineProperty(this, 'mod', {value: mod});
	}

	//kbps
	setBitrate(bitrate) {
		return this.setCTL(OpusSettings.CTL.BITRATE, Math.min(128000, Math.max(16000, bitrate)));
	}

	setFEC(enabled) {
		return this.setCTL(OpusSettings.CTL.FEC, +!!enabled);
	}

	setPLP(percentage) {
		return this.setCTL(OpusSettings.CTL.PLP, Math.min(100, Math.max(0, percentage)));
	}

	setCTL(flag, value) {
		if (!this.enabled) {
			throw new Error('Object was deleted, reinitialize with recreate()');
		}

		switch (this.mod) {
			case 'node-opus': {
				this.opus.applyEncoderCTL([flag, value]);
			}; break;
			case 'opusscript': {
				this.opus.encoderCTL([flag, value]);
			}; break;
		}
		return this;
	}

	encode(buf, frameDuration) {
		if (!this.enabled) {
			throw new Error('Object was deleted, reinitialize with recreate()');
		}

		const frameSize = (this.sampleRate / 1000) * frameDuration;

		let packet;
		switch(this.mod) {
			case 'node-opus': {
				packet = this.opus.encode(buf, frameSize);
			}; break;
			case 'opusscript': {
				packet = this.opus.encode(buf, frameSize);
			}; break;
		}
		return packet;
	}

	decode(buf, frameDuration) {
		if (!this.enabled) {
			throw new Error('Object was deleted, reinitialize with recreate()');
		}

		const frameSize = (this.sampleRate / 1000) * frameDuration;

		let packet;
		switch(this.mod) {
			case 'node-opus': {
				packet = this.opus.decode(buf, frameSize);
			}; break;
			case 'opusscript': {
				packet = this.opus.decode(buf);
			}; break;
		}

		return packet;
	}

<<<<<<< HEAD
	delete() {
		if (this.opus) {
			switch (this.mod) {
				case 'opusscript': {
					this.opus.delete();
				}; break;
			}
			Object.defineProperty(this, 'opus', {value: null});
=======
	delete()
	{
		if (this.opus) {
			this.opus.delete();
			this.opus = null;
>>>>>>> 05f9af6d13ec475021d1a6d24e67bb62f16d547d
		}
	}
}

module.exports = AudioOpus;