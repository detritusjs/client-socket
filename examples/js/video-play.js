const { spawn, spawnSync } = require('child_process');

const {
  Constants,
  Gateway,
} = require('../../lib');


const guildId = process.env.GUILD_ID || '';
const channelId = process.env.CHANNEL_ID || '';
const file = process.env.VIDEO_FILE || '';
const ffmpegPath = process.env.FFMPEG || 'ffmpeg';
const loop = !!process.env.LOOP;

const token = process.env.DISCORD_TOKEN || '';

// Plays a video file (anything ffmpeg can read) into a voice channel, video and audio.
// ffmpeg does the decoding/encoding, this paces the frames out in real time.
// The video codec is the one the voice server picks for the call (every viewer has to be able to decode it, the server
// doesn't transcode), it can change mid call when someone joins, ffmpeg gets restarted with the new encoder when it does.
// A file that's already in that codec (VP8/VP9, a webm usually) gets its video sent as is, no encoding (REENCODE=1 to
// always encode). For that, encode files with a keyframe every ~2s and no alt-ref frames, `-g 60 -auto-alt-ref 0`.
// The audio always gets encoded, opus is cheap and that way it's always 48kHz stereo in 20ms frames
// Discord forces `self_video` off for bot accounts, so the official client never shows a tile for it, but the video
// still gets delivered and decoded (check the bot under Inbound in the client's RTC debug panel). The audio plays normally

const FPS = 30;
// rtp video runs on a 90kHz clock
const FRAME_TICKS = 90000 / FPS;
const FRAME_MS = 1000 / FPS;
// opus frames are 20ms
const AUDIO_FRAME_MS = 20;


// splits ffmpeg's raw h264 into frames, `aud=1` makes x264 start every frame with an access unit delimiter (nal type 9)
// raw h264 has no timestamps, ffmpeg outputs it at a constant FPS
class AnnexBFrameReader {
  constructor(onFrame) {
    this.buffer = Buffer.alloc(0);
    this.frames = 0;
    this.onFrame = onFrame;
  }

  static isDelimiter(buffer, i) {
    return buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 0 && buffer[i + 3] === 1 && (buffer[i + 4] & 0x1F) === 9;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let start = 0;
    for (let i = 1; i + 5 <= this.buffer.length; i++) {
      if (AnnexBFrameReader.isDelimiter(this.buffer, i)) {
        this.emit(this.buffer.subarray(start, i));
        start = i;
      }
    }
    this.buffer = this.buffer.subarray(start);
  }

  end() {
    if (this.buffer.length) {
      this.emit(this.buffer);
    }
    this.buffer = Buffer.alloc(0);
  }

  emit(frame) {
    // keyframes have an idr slice (nal type 5)
    let keyframe = false;
    for (let i = 0; i + 4 < frame.length; i++) {
      if (frame[i] === 0 && frame[i + 1] === 0 && frame[i + 2] === 1 && (frame[i + 3] & 0x1F) === 5) {
        keyframe = true;
        break;
      }
    }
    this.onFrame({data: Buffer.from(frame), keyframe, ms: this.frames++ * FRAME_MS});
  }
}

// ffmpeg's vp8/vp9 comes in an ivf container, a 32 byte file header then a 12 byte header (size, pts) before every frame
// the pts keeps the file's own timing, which a copied stream needs (any frame rate, even a variable one)
class IVFFrameReader {
  constructor(onFrame, isKeyframe) {
    this.buffer = Buffer.alloc(0);
    this.headerRead = false;
    this.timebase = 0;
    this.isKeyframe = isKeyframe;
    this.onFrame = onFrame;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.headerRead) {
      if (this.buffer.length < 32) {
        return;
      }
      // the timebase as denominator then numerator
      this.timebase = this.buffer.readUInt32LE(20) / this.buffer.readUInt32LE(16);
      this.buffer = this.buffer.subarray(this.buffer.readUInt16LE(6));
      this.headerRead = true;
    }
    while (12 <= this.buffer.length) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 12 + length) {
        return;
      }
      const ms = Number(this.buffer.readBigInt64LE(4)) * this.timebase * 1000;
      const data = Buffer.from(this.buffer.subarray(12, 12 + length));
      this.onFrame({data, keyframe: this.isKeyframe(data), ms});
      this.buffer = this.buffer.subarray(12 + length);
    }
  }

  end() {}
}

// RFC 3533, pulls the opus packets out of ffmpeg's ogg pages (skipping the OpusHead/OpusTags headers)
class OggOpusReader {
  constructor(onPacket) {
    this.buffer = Buffer.alloc(0);
    this.partial = [];
    this.headers = 0;
    this.onPacket = onPacket;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (27 <= this.buffer.length) {
      if (this.buffer.toString('ascii', 0, 4) !== 'OggS') {
        throw new Error('Lost sync with the ogg stream');
      }
      const segments = this.buffer[26];
      if (this.buffer.length < 27 + segments) {
        return;
      }
      const lacing = this.buffer.subarray(27, 27 + segments);
      const bodyLength = lacing.reduce((total, x) => total + x, 0);
      if (this.buffer.length < 27 + segments + bodyLength) {
        return;
      }

      let offset = 27 + segments;
      for (let size of lacing) {
        this.partial.push(this.buffer.subarray(offset, offset + size));
        offset += size;
        // a lacing value of 255 means the packet continues in the next segment (or page)
        if (size < 255) {
          const packet = Buffer.concat(this.partial);
          this.partial = [];
          if (this.headers < 2) {
            this.headers++;
          } else {
            this.onPacket(packet);
          }
        }
      }
      this.buffer = this.buffer.subarray(offset);
    }
  }
}

// what ffmpeg has to do and how its output gets read and sent, per codec the voice server can pick
const ENCODERS = {
  [Constants.MediaCodecs.VP8]: {
    // no alt-ref frames (vp8's hidden frames), every frame we send is one that gets shown
    args: ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-auto-alt-ref', '0', '-lag-in-frames', '0',
      '-error-resilient', '1', '-f', 'ivf'],
    // RFC 6386 Section 9.1, the frame tag's P bit is 0 for keyframes
    reader: (onFrame) => new IVFFrameReader(onFrame, (data) => (data[0] & 0x01) === 0),
    // the frame tag's show_frame bit, libvpx's alt-ref frames are never shown on their own
    hidden: (data) => ((data[0] >> 4) & 0x01) === 0,
  },
  [Constants.MediaCodecs.VP9]: {
    args: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-auto-alt-ref', '0',
      '-lag-in-frames', '0', '-error-resilient', '1', '-f', 'ivf'],
    // profile 0 frame header, show_existing_frame and frame_type are both 0 for keyframes
    reader: (onFrame) => new IVFFrameReader(onFrame, (data) => ((data[0] >> 2) & 0x03) === 0),
  },
  [Constants.MediaCodecs.H264]: {
    // no b-frames, rtp timestamps have to go up with every frame we send. constrained baseline is what browsers take
    args: ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'baseline', '-bf', '0',
      '-x264-params', 'aud=1:repeat-headers=1', '-f', 'h264'],
    reader: (onFrame) => new AnnexBFrameReader(onFrame),
  },
};

function probe() {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-i', file], {encoding: 'utf8'});
  const output = result.stderr || '';
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(output);
  const video = /Stream #\d+:\d+.*?: Video: (\w+)/.exec(output);
  return {
    duration: (duration) ? (Number(duration[1]) * 3600) + (Number(duration[2]) * 60) + Number(duration[3]) : null,
    // ffmpeg's codec names, `vp8`/`vp9`/`h264`, as ours
    videoCodec: (video) ? video[1].toUpperCase() : null,
    withAudio: /Stream #\d+:\d+.*: Audio:/.test(output),
  };
}

// a file that's already vp8/vp9 in the codec the voice server picked gets its frames sent as is, no encoding at all
// (h264 isn't copied, raw h264 has no timestamps and files usually have b-frames)
function canCopy(fileCodec, codec) {
  return fileCodec === codec && (codec === Constants.MediaCodecs.VP8 || codec === Constants.MediaCodecs.VP9);
}

function startFFmpeg(codec, startAt, withAudio, copy, onVideoFrame, onAudioPacket, onEnd) {
  const encoder = ENCODERS[codec];
  const args = ['-hide_banner', '-loglevel', 'error', '-re'];
  if (loop) {
    args.push('-stream_loop', '-1');
  }
  if (startAt) {
    // with a copied stream, ffmpeg starts at the keyframe before this
    args.push('-ss', startAt.toFixed(3));
  }
  args.push('-i', file, '-map', '0:v:0');
  if (copy) {
    args.push('-c:v', 'copy', '-f', 'ivf', 'pipe:1');
  } else {
    args.push(
      '-pix_fmt', 'yuv420p', '-vf', `scale='min(1280,iw)':-2,fps=${FPS}`,
      '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k',
      // a keyframe every 2 seconds, a viewer that joins (or loses something nacks can't fix) waits at most that long
      '-g', String(FPS * 2), '-keyint_min', String(FPS * 2),
      ...encoder.args, 'pipe:1',
    );
  }
  if (withAudio) {
    args.push(
      '-map', '0:a:0',
      '-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-b:a', '128k', '-frame_duration', String(AUDIO_FRAME_MS),
      '-application', 'audio', '-f', 'ogg', 'pipe:3',
    );
  }

  const ffmpeg = spawn(ffmpegPath, args, {stdio: ['ignore', 'pipe', 'inherit', 'pipe']});
  const video = encoder.reader(onVideoFrame);
  ffmpeg.stdout.on('data', (chunk) => video.push(chunk));
  ffmpeg.stdout.on('end', () => video.end());
  if (withAudio) {
    const audio = new OggOpusReader(onAudioPacket);
    ffmpeg.stdio[3].on('data', (chunk) => audio.push(chunk));
  }
  ffmpeg.on('close', onEnd);
  return ffmpeg;
}


const client = new Gateway.Socket(token, {
  compress: true,
  guildSubscriptions: false,
  presence: {
    activity: {
      name: file,
      type: Constants.GatewayActivityTypes.PLAYING,
    },
    status: Constants.GatewayPresenceStatuses.ONLINE,
  },
});

client.on('close', ({code, reason}) => {
  console.log('gateway close', code, reason);
});

client.on('open', () => {
  console.log('opened gateway on', client.url.href);
});

client.on('ready', async () => {
  const media = await client.voiceConnect(guildId, channelId, {receive: false, video: true, selfVideo: true});
  media.on('warn', console.error);

  let started = false;
  media.on('transportReady', (transport) => {
    // tell everyone our video stream is live
    media.sendClientConnect({videoActive: true});
    if (started) {
      return;
    }
    started = true;
    transport.on('warn', console.error);
    // nacks are answered by the library, a keyframe request has to wait for ffmpeg's next keyframe (2 seconds at most)
    transport.on('keyframeRequest', () => {});

    const videoQueue = [];
    const audioQueue = [];
    const { duration, videoCodec: fileCodec, withAudio } = probe();

    let codec = null;
    let copying = false;
    let ffmpeg = null;
    let ffmpegDone = false;
    // which ffmpeg run is current, output from one we replaced is thrown away
    let run = 0;

    let clockStart = null;
    // the current run's first frame time, its frames are paced (and timestamped) relative to it
    let runStartMs = null;
    // where in the file the current run started, and the rtp timestamp its first frame gets
    let runPosition = 0;
    let runTicks = 0;
    // the last frame we sent, a restart picks up right after it
    let sentOffsetMs = null;
    let sentTicks = null;
    let videoFrames = 0;
    let audioFrames = 0;
    // the audio count when the current run started, pacing starts over from its first packet
    let audioBase = 0;
    let speaking = false;
    let waitingForKeyframe = true;
    let warnedHidden = false;

    const play = (nextCodec) => {
      if (!ENCODERS[nextCodec]) {
        console.error(`no encoder for ${nextCodec}, the voice server picked a codec this example can't send`);
        return;
      }
      codec = nextCodec;
      copying = canCopy(fileCodec, codec) && !process.env.REENCODE;
      if (ffmpeg) {
        ffmpeg.kill('SIGKILL');
      }
      const current = ++run;
      videoQueue.length = 0;
      audioQueue.length = 0;
      ffmpegDone = false;
      // the new run's first frame is a keyframe, nothing before it would decode anyways
      waitingForKeyframe = true;

      // pick up where the last run left off, both rtp clocks keep going
      if (sentOffsetMs !== null) {
        runPosition += (sentOffsetMs + FRAME_MS) / 1000;
        runTicks = (sentTicks + FRAME_TICKS) >>> 0;
      }
      if (loop && duration) {
        runPosition %= duration;
      }
      clockStart = null;
      runStartMs = null;
      sentOffsetMs = null;
      audioBase = audioFrames;

      const how = (copying) ? `copying its ${codec}` : `encoding ${codec}${(fileCodec) ? ` from ${fileCodec}` : ''}`;
      console.log(`playing ${file} from ${runPosition.toFixed(1)}s, ${how}${(withAudio) ? '' : ' (no audio track)'}`);
      ffmpeg = startFFmpeg(
        codec,
        runPosition,
        withAudio,
        copying,
        (frame) => (current === run) && videoQueue.push(frame),
        (packet) => (current === run) && audioQueue.push(packet),
        () => (current === run) && (ffmpegDone = true),
      );
    };

    // the server says which codec in SELECT_PROTOCOL_ACK, and again in SESSION_UPDATE whenever it changes
    play(transport.codecs.video || Constants.MediaCodecs.VP8);
    transport.on('videoCodec', (nextCodec) => {
      console.log(`voice server switched the video codec to ${nextCodec}`);
      play(nextCodec);
    });

    // the clock keeps going no matter what, whatever can't be sent when its time comes (reconnecting, DAVE transition)
    // gets dropped, playback picks back up at the next keyframe instead of falling behind
    const tick = () => {
      if (clockStart === null) {
        if (!videoQueue.length) {
          return;
        }
        clockStart = Date.now();
        runStartMs = videoQueue[0].ms;
      }
      const elapsed = Date.now() - clockStart;

      // both streams run off the same clock so they stay in sync
      while (audioQueue.length && (audioFrames - audioBase) * AUDIO_FRAME_MS <= elapsed) {
        if (!speaking) {
          media.sendSpeaking({voice: true});
          speaking = true;
        }
        transport.sendAudioFrame(audioQueue.shift());
        audioFrames++;
      }

      // frames go out when their own timestamp comes up, a copied file keeps whatever frame rate it has
      while (videoQueue.length && videoQueue[0].ms - runStartMs <= elapsed) {
        const frame = videoQueue.shift();
        const offsetMs = frame.ms - runStartMs;
        const timestamp = (runTicks + Math.round(offsetMs * 90)) >>> 0;
        sentOffsetMs = offsetMs;
        sentTicks = timestamp;
        videoFrames++;
        if (waitingForKeyframe) {
          // viewers can only start decoding from a keyframe
          if (!frame.keyframe) {
            continue;
          }
          waitingForKeyframe = false;
        }
        if (copying && !warnedHidden && ENCODERS[codec].hidden && ENCODERS[codec].hidden(frame.data)) {
          console.warn(`${file} has hidden (alt-ref) frames, viewers may stutter. Encode it with \`-auto-alt-ref 0\` to copy it cleanly`);
          warnedHidden = true;
        }

        // e2e encrypts, packetizes and sends it. false means it got dropped, nothing decodes until the next keyframe
        if (!transport.sendVideo(frame.data, {codec, keyframe: frame.keyframe, timestamp})) {
          waitingForKeyframe = true;
        }
      }

      if (ffmpegDone && !videoQueue.length && !audioQueue.length) {
        clearInterval(interval);
        media.sendSpeaking({voice: false});
        media.sendClientConnect({videoActive: false});
        console.log(`finished, ${videoFrames} video frames and ${audioFrames} audio frames`);
      }
    };
    const interval = setInterval(tick, 5);
  });
});

client.on('warn', console.error);

client.connect('wss://gateway.discord.gg');
