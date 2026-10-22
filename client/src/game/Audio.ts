import { WEAPONS, type Vec3, type WeaponId, type WeaponSound } from '@game/shared';
import { storage } from '../ui/dom';

export type SoundName =
  | WeaponSound
  | 'meleeHit'
  | 'beep'
  | 'bonk'
  | 'explosion'
  | 'hit'
  | 'headshot'
  | 'kill'
  | 'hurt'
  | 'reload'
  | 'empty'
  | 'switch'
  | 'jump'
  | 'jet'
  | 'throw'
  | 'pin'
  | 'shellClink'
  | 'shellThud'
  | 'pickup'
  | 'death'
  | 'poof'
  | 'boxBreak'
  | 'smokePop'
  | 'click'
  | 'reward'
  | 'countdown'
  | 'engine'
  | 'flashbang'
  | 'ring'
  | 'keypad'
  | 'defuseTick'
  | 'bombPlanted'
  | 'defused'
  | 'bigBoom'
  | 'scream'
  | 'static'
  | 'scareHit'
  | 'glassCrack'
  | 'wail'
  | 'heartbeat'
  | 'giggle'
  | 'sniperZoom'
  | 'equip'
  | 'groan'
  | 'zstep'
  | 'screech'
  | 'wind'
  | 'cluck'
  | 'creak'
  | 'hiss'
  | 'pant'
  | 'roar'
  | 'bossRoar'
  | 'zstepLight'
  | 'zstepHeavy'
  | 'zclaw'
  | 'zsmash'
  | 'zdeath'
  | 'reloadMag'
  | 'reloadShell'
  | 'reloadBolt'
  | 'emptyHeavy'
  | 'bloodMoon'
  | 'gurgle'
  | 'fuse'
  | 'powerUp'
  | 'nuke'
  | 'hoot'
  | 'monkeyShriek'
  | 'crystal'
  | 'portal'
  | 'scareSting'
  | 'buzz'
  | 'powerDown'
  | 'splash';

const VOLUME_KEY = 'chikengun:volume';
const MUSIC_KEY = 'chikengun:music-volume';
/** The title screen's music: loops while you're in the menus (the file's exact name). */
const LOBBY_MUSIC = '/sounds/chickenRunHvh_theme.mp3';
/** Seconds to fade the music in and out. */
const MUSIC_FADE = 0.8;
/** Your own sound files live in client/public/sounds/ (served from /sounds/). */
export const JUMPSCARE_FILE = '/sounds/jumpscare.mp3';
/** Clicking your chicken on the title screen. */
export const MENU_CLUCK_FILE = '/sounds/chicken_cluck_1s.mp3';
/**
 * Your own recordings, played instead of a built-in sound once loaded (put the file in
 * client/public/sounds and its licence in SOUNDS.md). Empty: every sound is built in; the old
 * AWP_SOUND, SNIPER_ZOOM and equip_sound files have no known free licence (see SOUNDS.md).
 */
const FILE_SOUNDS: Partial<Record<SoundName, string>> = {
  // The story-event scare: built in; to use your own, put the file in client/public/sounds and
  // add (for example) `scareSting: '/sounds/scare_sting.mp3',` here.
};
/** Quieter than this (about -40 dB) counts as silence, trimmed off both ends of a file. */
const SILENCE = 0.01;
/** Which reload sound a gun makes (a magazine swap, shells one by one, or a bolt gun). */
export function reloadSoundFor(id: WeaponId): SoundName {
  if (id === 'shotgun' || id === 'autoshotgun') return 'reloadShell';
  if (id === 'sniper' || id === 'scout' || id === 'ssg08') return 'reloadBolt';
  return WEAPONS[id].projectile ? 'reload' : 'reloadMag';
}

/** The dry click: a heavier one for big guns. */
export function emptySoundFor(id: WeaponId): SoundName {
  return WEAPONS[id].csgo || id === 'sniper' || id === 'scout' || id === 'shotgun' || id === 'autoshotgun' || id === 'revolver' || id === 'deagle' ? 'emptyHeavy' : 'empty';
}

/**
 * The echo that follows a shot: taps `gap` seconds apart, each quieter and duller. Far shots
 * echo more (from far away you hear the reflection more than the shot).
 */
const ECHO: Partial<Record<SoundName, { taps: number; gain: number; gap: number; freq: number }>> = {
  sniper: { taps: 4, gain: 0.5, gap: 0.24, freq: 650 },
  scout: { taps: 3, gain: 0.4, gap: 0.19, freq: 800 },
  rifle: { taps: 2, gain: 0.22, gap: 0.15, freq: 900 },
  battle: { taps: 2, gain: 0.26, gap: 0.16, freq: 800 },
  shotgun: { taps: 2, gain: 0.3, gap: 0.2, freq: 700 },
  deagle: { taps: 2, gain: 0.26, gap: 0.17, freq: 800 },
  revolver: { taps: 2, gain: 0.22, gap: 0.16, freq: 850 },
  lmg: { taps: 2, gain: 0.18, gap: 0.14, freq: 800 },
  pistol: { taps: 1, gain: 0.15, gap: 0.12, freq: 1000 },
  smg: { taps: 1, gain: 0.1, gap: 0.1, freq: 1000 },
};
/** Beyond this distance a sound is silent. */
const HEARING_RANGE = 70;
const MAX_VOICES = 64;

/** A copy of `buffer` without the silence at its start and end (a few ms are kept either side). */
export function trimSilence(ctx: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
  let first = buffer.length;
  let last = -1;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    let i = 0;
    while (i < data.length && Math.abs(data[i]!) < SILENCE) i++;
    let j = data.length - 1;
    while (j > i && Math.abs(data[j]!) < SILENCE) j--;
    if (i < data.length) {
      first = Math.min(first, i);
      last = Math.max(last, j);
    }
  }
  if (last < first) return buffer;
  const pad = Math.round(buffer.sampleRate * 0.005);
  const start = Math.max(0, first - pad);
  const end = Math.min(buffer.length, last + pad);
  if (start === 0 && end === buffer.length) return buffer;
  const out = ctx.createBuffer(buffer.numberOfChannels, end - start, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c++) out.copyToChannel(buffer.getChannelData(c).subarray(start, end), c);
  return out;
}

function safeVolume(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.6;
}

interface Voice {
  sources: number;
  release: () => void;
}

interface Listener {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * Synthesized sound effects (no audio files). Every sound is a short graph of oscillators
 * and filtered noise, panned and attenuated by distance from the camera.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private listener: Listener = { x: 0, y: 0, z: 0, yaw: 0 };
  private volumeValue = safeVolume(Number(storage.get(VOLUME_KEY) ?? '0.6'));
  /** Music: its own volume (under the main volume), whether the menus want it, and what's playing. */
  private musicVolumeValue = safeVolume(Number(storage.get(MUSIC_KEY) ?? '0.4'));
  private musicWanted = false;
  private musicGain: GainNode | null = null;
  /** The theme is four minutes long: streamed from an <audio> element, not decoded whole (~85 MB). */
  private musicEl: HTMLAudioElement | null = null;
  private musicPlaying = false;
  private musicPause = 0;
  /** The main volume, for the music (which skips the effects compressor). */
  private musicOut: GainNode | null = null;
  private readonly voices = new WeakMap<AudioNode, Voice>();
  private activeVoices = 0;
  /** Decoded sound files by URL (null: it could not be loaded, so the built-in sound is used). */
  private readonly files = new Map<string, Promise<AudioBuffer | null>>();
  /** FILE_SOUNDS that have loaded, trimmed of silence, ready to play. */
  private readonly fileBuffers = new Map<SoundName, AudioBuffer>();

  get volume(): number {
    return this.volumeValue;
  }

  set volume(v: number) {
    this.volumeValue = safeVolume(v);
    storage.set(VOLUME_KEY, String(this.volumeValue));
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.volumeValue, this.ctx.currentTime, 0.015);
    if (this.musicOut && this.ctx) this.musicOut.gain.setTargetAtTime(this.volumeValue, this.ctx.currentTime, 0.015);
  }

  get musicVolume(): number {
    return this.musicVolumeValue;
  }

  set musicVolume(v: number) {
    this.musicVolumeValue = safeVolume(v);
    storage.set(MUSIC_KEY, String(this.musicVolumeValue));
    if (this.musicGain && this.ctx && this.musicPlaying) this.musicGain.gain.setTargetAtTime(this.musicVolumeValue, this.ctx.currentTime, 0.05);
  }

  /**
   * The lobby music: on in the menus, off in a match. It starts as soon as the browser allows
   * sound (your first click), fades in and out, loops, and picks up where it stopped.
   */
  setMusic(on: boolean): void {
    this.musicWanted = on;
    this.syncMusic();
  }

  private syncMusic(): void {
    const ctx = this.ctx;
    const el = this.musicEl;
    if (!ctx || !this.master || !this.musicGain || !el) return;
    const t = ctx.currentTime;
    if (this.musicWanted && !this.musicPlaying && ctx.state === 'running') {
      this.musicPlaying = true;
      clearTimeout(this.musicPause);
      this.musicGain.gain.cancelScheduledValues(t);
      this.musicGain.gain.setValueAtTime(0, t);
      this.musicGain.gain.linearRampToValueAtTime(this.musicVolumeValue, t + MUSIC_FADE);
      void el.play().catch(() => { this.musicPlaying = false; });
    } else if (!this.musicWanted && this.musicPlaying) {
      this.musicPlaying = false;
      this.musicGain.gain.cancelScheduledValues(t);
      this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, t);
      this.musicGain.gain.linearRampToValueAtTime(0, t + MUSIC_FADE);
      this.musicPause = window.setTimeout(() => el.pause(), (MUSIC_FADE + 0.05) * 1000);
    }
  }

  /** Browsers only allow audio after a user gesture, so call this from a click handler. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volumeValue;
      const compressor = this.ctx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.knee.value = 16;
      compressor.ratio.value = 5;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.18;
      this.master.connect(compressor).connect(this.ctx.destination);
      this.noise = this.makeNoise();
      // Music goes through the main volume too, but not the compressor (it would pump).
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0;
      const musicOut = this.ctx.createGain();
      musicOut.gain.value = this.volumeValue;
      this.musicGain.connect(musicOut).connect(this.ctx.destination);
      this.musicOut = musicOut;
      this.ctx.addEventListener('statechange', () => this.syncMusic());
      const el = new Audio(LOBBY_MUSIC);
      el.loop = true;
      this.ctx.createMediaElementSource(el).connect(this.musicGain);
      this.musicEl = el;
      this.syncMusic();
      void this.load(JUMPSCARE_FILE);
      for (const [name, url] of Object.entries(FILE_SOUNDS) as [SoundName, string][]) {
        void this.load(url).then((buffer) => {
          if (buffer && this.ctx) this.fileBuffers.set(name, trimSilence(this.ctx, buffer));
        });
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
  }

  private engine: { osc: OscillatorNode; sub: OscillatorNode; filter: BiquadFilterNode; gain: GainNode } | null = null;

  /**
   * Your own buggy's engine: a growl whose pitch follows the speed (0–1+), louder on nitro.
   * null turns it off.
   */
  setEngine(level: number | null, boosting = false): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    if (level === null) {
      if (!this.engine) return;
      const e = this.engine;
      this.engine = null;
      e.gain.gain.setTargetAtTime(0, t, 0.08);
      e.osc.stop(t + 0.5);
      e.sub.stop(t + 0.5);
      return;
    }
    if (!this.engine) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const sub = ctx.createOscillator();
      sub.type = 'square';
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 3;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(filter);
      sub.connect(filter);
      filter.connect(gain).connect(this.master);
      osc.start();
      sub.start();
      this.engine = { osc, sub, filter, gain };
    }
    const e = this.engine;
    const l = Math.max(0, level);
    e.osc.frequency.setTargetAtTime(48 + l * 95 + (boosting ? 35 : 0), t, 0.06);
    e.sub.frequency.setTargetAtTime(24 + l * 47, t, 0.06);
    e.filter.frequency.setTargetAtTime(380 + l * 900 + (boosting ? 900 : 0), t, 0.08);
    e.gain.gain.setTargetAtTime(0.05 + l * 0.05 + (boosting ? 0.04 : 0), t, 0.1);
  }

  setListener(x: number, y: number, z: number, yaw: number): void {
    this.listener = { x, y, z, yaw };
  }

  /** Plays a sound, optionally at a world position (attenuated and panned). */
  /** How long the next ear ringing lasts (seconds); set by ringFor. */
  private ringSeconds = 2.8;

  /** Ears ringing after a flash: as long as the white-out, fading away, quieter when barely caught. */
  ringFor(seconds: number, volume: number): void {
    this.ringSeconds = Math.max(0.6, seconds);
    this.play('ring', undefined, volume);
  }

  play(name: SoundName, at?: Vec3, volume = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running' || this.volumeValue === 0 || !Number.isFinite(volume) || volume <= 0) return;
    // Preserve local feedback when the arena is busy; distant shots are the first to be dropped.
    if (this.activeVoices >= MAX_VOICES && at) return;
    if (this.activeVoices >= MAX_VOICES * 2) return;
    let gain = Math.min(2, volume);
    let pan = 0;
    let distance = 0;
    if (at) {
      const dx = at.x - this.listener.x;
      const dz = at.z - this.listener.z;
      const dist = Math.hypot(dx, at.y - this.listener.y, dz);
      if (!Number.isFinite(dist) || dist >= HEARING_RANGE) return;
      distance = dist;
      gain *= (1 - (dist / HEARING_RANGE) ** 4) / (1 + dist * 0.12);
      // Project onto the listener's right vector for left/right panning.
      const rightX = Math.cos(this.listener.yaw);
      const rightZ = -Math.sin(this.listener.yaw);
      pan = dist > 0.5 ? Math.max(-1, Math.min(1, (dx * rightX + dz * rightZ) / dist)) * 0.8 : 0;
    }
    const out = ctx.createGain();
    out.gain.value = gain;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    const distanceFilter = ctx.createBiquadFilter();
    distanceFilter.type = 'lowpass';
    distanceFilter.frequency.value = Math.max(1800, 18000 / (1 + distance * 0.07));
    distanceFilter.Q.value = 0.5;
    out.connect(distanceFilter).connect(panner).connect(this.master);
    this.activeVoices++;
    const voice: Voice = {
      sources: 0,
      release: () => {
        out.disconnect();
        distanceFilter.disconnect();
        panner.disconnect();
        this.voices.delete(out);
        this.activeVoices--;
      },
    };
    this.voices.set(out, voice);
    const file = this.fileBuffers.get(name);
    if (file) {
      // Your own recording, through the same distance and left/right chain as the built-in sounds.
      const src = ctx.createBufferSource();
      src.buffer = file;
      src.connect(out);
      this.track(out, src, [src]);
      src.start();
    } else {
      this.synth(name, ctx, out, ctx.currentTime);
      const echo = ECHO[name];
      if (echo) this.echo(ctx, out, ctx.currentTime, echo, distance);
    }
    if (voice.sources === 0) voice.release();
  }

  private load(url: string): Promise<AudioBuffer | null> {
    let buffer = this.files.get(url);
    if (!buffer) {
      const ctx = this.ctx;
      buffer = ctx
        ? fetch(url)
            .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(String(res.status)))))
            .then((data) => ctx.decodeAudioData(data))
            .catch(() => null)
        : Promise.resolve(null);
      this.files.set(url, buffer);
    }
    return buffer;
  }

  /** Plays one of your own sound files at full screen volume; false if it isn't available (use a built-in sound). */
  async playFile(url: string, volume = 1): Promise<boolean> {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running') return false;
    const buffer = await this.load(url);
    if (!buffer) return false;
    if (this.volumeValue === 0) return true;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = Math.min(2, Math.max(0, volume));
    src.connect(gain).connect(this.master);
    src.onended = () => {
      src.disconnect();
      gain.disconnect();
    };
    src.start();
    return true;
  }

  /** Disconnect complete graphs after the final layer; automatic fire must not retain silent nodes. */
  private track(out: AudioNode, source: AudioScheduledSourceNode, nodes: AudioNode[]): void {
    const voice = this.voices.get(out)!;
    voice.sources++;
    source.onended = () => {
      for (const node of nodes) node.disconnect();
      source.onended = null;
      if (--voice.sources === 0) voice.release();
    };
  }

  private makeNoise(): AudioBuffer {
    const ctx = this.ctx!;
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** Filtered noise burst with an exponential decay. */
  private burst(ctx: AudioContext, out: AudioNode, t: number, o: { dur: number; type: BiquadFilterType; freq: number; to?: number; q?: number; gain?: number; delay?: number }): void {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = o.type;
    filter.Q.value = o.q ?? 1;
    const start = t + (o.delay ?? 0);
    filter.frequency.setValueAtTime(o.freq, start);
    if (o.to) filter.frequency.exponentialRampToValueAtTime(o.to, start + o.dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(o.gain ?? 1, start);
    env.gain.exponentialRampToValueAtTime(0.001, start + o.dur);
    src.connect(filter).connect(env).connect(out);
    this.track(out, src, [src, filter, env]);
    src.start(start, Math.random() * 0.5);
    src.stop(start + o.dur + 0.05);
  }

  /** Oscillator sweep with an exponential decay. */
  private tone(ctx: AudioContext, out: AudioNode, t: number, o: { dur: number; type: OscillatorType; freq: number; to?: number; gain?: number; delay?: number }): void {
    const osc = ctx.createOscillator();
    osc.type = o.type;
    const start = t + (o.delay ?? 0);
    osc.frequency.setValueAtTime(o.freq, start);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, start + o.dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(o.gain ?? 0.5, start);
    env.gain.exponentialRampToValueAtTime(0.001, start + o.dur);
    osc.connect(env).connect(out);
    this.track(out, osc, [osc, env]);
    osc.start(start);
    osc.stop(start + o.dur + 0.05);
  }

  /** A chicken squawk: a buzzy sawtooth through a vocal-ish filter, pitch up then down, with vibrato. */
  private squawk(ctx: AudioContext, out: AudioNode, t: number, o: { delay: number; freq: number; peak: number; end: number; dur: number; gain: number }): void {
    const start = t + o.delay;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(o.freq, start);
    osc.frequency.exponentialRampToValueAtTime(o.peak, start + o.dur * 0.3);
    osc.frequency.exponentialRampToValueAtTime(o.end, start + o.dur);
    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = 34;
    const depth = ctx.createGain();
    depth.gain.value = o.peak * 0.06;
    vibrato.connect(depth).connect(osc.frequency);
    const formant = ctx.createBiquadFilter();
    formant.type = 'bandpass';
    formant.frequency.value = 1700;
    formant.Q.value = 2.5;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(o.gain, start + 0.02);
    env.gain.exponentialRampToValueAtTime(0.001, start + o.dur);
    osc.connect(formant).connect(env).connect(out);
    this.track(out, osc, [osc, vibrato, depth, formant, env]);
    for (const n of [osc, vibrato]) {
      n.start(start);
      n.stop(start + o.dur + 0.05);
    }
  }

  /** Echo taps after a shot (see ECHO). */
  private echo(ctx: AudioContext, out: AudioNode, t: number, e: { taps: number; gain: number; gap: number; freq: number }, distance: number): void {
    const far = 1 + Math.min(1, distance / 40);
    for (let i = 1; i <= e.taps; i++) {
      const g = e.gain * far * 0.55 ** (i - 1);
      this.burst(ctx, out, t, { dur: 0.3 + i * 0.08, type: 'lowpass', freq: e.freq / (1 + i * 0.35), to: 120, gain: g, delay: e.gap * i + 0.05 });
      this.tone(ctx, out, t, { dur: 0.22, type: 'sine', freq: 90 / (1 + i * 0.2), to: 40, gain: g * 0.4, delay: e.gap * i + 0.05 });
    }
  }

  /** A rifle bolt being worked: lift and pull back, then forward and down (a heavy one is deeper). */
  private bolt(ctx: AudioContext, out: AudioNode, t: number, delay: number, heavy: boolean): void {
    const k = heavy ? 1 : 0.8;
    this.burst(ctx, out, t, { dur: 0.04, type: 'bandpass', freq: 1500, q: 4, gain: 0.35 * k, delay });
    this.burst(ctx, out, t, { dur: 0.12, type: 'bandpass', freq: heavy ? 700 : 900, to: 400, q: 1.5, gain: 0.3 * k, delay: delay + 0.04 });
    this.burst(ctx, out, t, { dur: 0.05, type: 'highpass', freq: 3200, gain: 0.25 * k, delay: delay + 0.2 });
    this.burst(ctx, out, t, { dur: 0.07, type: 'bandpass', freq: 1100, q: 3, gain: 0.4 * k, delay: delay + 0.3 });
    this.tone(ctx, out, t, { dur: 0.09, type: 'sine', freq: heavy ? 130 : 160, to: 70, gain: 0.3 * k, delay: delay + 0.3 });
    this.burst(ctx, out, t, { dur: 0.05, type: 'highpass', freq: 2600, gain: 0.3 * k, delay: delay + 0.38 });
  }

  /** A throaty voice: a sawtooth through a low formant, sliding down, with a slow wobble. */
  private growl(ctx: AudioContext, out: AudioNode, t: number, o: { freq: number; end: number; dur: number; gain: number; formant: number; q?: number; wobble?: number; delay?: number }): void {
    const start = t + (o.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(o.freq, start);
    osc.frequency.exponentialRampToValueAtTime(o.end, start + o.dur);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = o.wobble ?? 6;
    const depth = ctx.createGain();
    depth.gain.value = o.freq * 0.07;
    lfo.connect(depth).connect(osc.frequency);
    const formant = ctx.createBiquadFilter();
    formant.type = 'bandpass';
    formant.frequency.value = o.formant;
    formant.Q.value = o.q ?? 3;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(o.gain, start + o.dur * 0.25);
    env.gain.exponentialRampToValueAtTime(0.001, start + o.dur);
    osc.connect(formant).connect(env).connect(out);
    this.track(out, osc, [osc, lfo, depth, formant, env]);
    for (const n of [osc, lfo]) {
      n.start(start);
      n.stop(start + o.dur + 0.05);
    }
  }

  /** Looping noise that slowly swells and fades (a gust of wind). */
  private swell(ctx: AudioContext, out: AudioNode, t: number, o: { dur: number; freq: number; to: number; q: number; gain: number }): void {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = o.q;
    filter.frequency.setValueAtTime(o.freq, t);
    filter.frequency.linearRampToValueAtTime(o.to, t + o.dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(o.gain, t + o.dur * 0.45);
    env.gain.linearRampToValueAtTime(0, t + o.dur);
    src.connect(filter).connect(env).connect(out);
    this.track(out, src, [src, filter, env]);
    src.start(t, Math.random() * 0.9);
    src.stop(t + o.dur + 0.05);
  }

  private synth(name: SoundName, ctx: AudioContext, out: AudioNode, t: number): void {
    // Tiny pitch changes keep bursts from sounding like a machine repeating the same sample.
    const pitch = 0.96 + Math.random() * 0.08;
    switch (name) {
      // The zombie night (soft on purpose: they set the mood, the guns stay the loud part).
      case 'groan':
        this.growl(ctx, out, t, { freq: 92 * pitch, end: 62, dur: 1.3, gain: 0.32, formant: 520 });
        this.growl(ctx, out, t, { freq: 138 * pitch, end: 90, dur: 1.1, gain: 0.12, formant: 820, delay: 0.08 });
        break;
      case 'zstep':
        this.burst(ctx, out, t, { dur: 0.09, type: 'lowpass', freq: 380 * pitch, gain: 0.32 });
        this.tone(ctx, out, t, { dur: 0.07, type: 'sine', freq: 78 * pitch, to: 48, gain: 0.18 });
        break;
      case 'screech':
        this.squawk(ctx, out, t, { delay: 0, freq: 620 * pitch, peak: 1250, end: 420, dur: 0.6, gain: 0.26 });
        this.burst(ctx, out, t, { dur: 0.45, type: 'bandpass', freq: 2300, to: 1200, q: 2, gain: 0.07 });
        break;
      case 'wind':
        this.swell(ctx, out, t, { dur: 4.8, freq: 420 * pitch, to: 260, q: 0.8, gain: 0.5 });
        break;
      case 'cluck':
        this.squawk(ctx, out, t, { delay: 0, freq: 360 * pitch, peak: 520, end: 300, dur: 0.11, gain: 0.3 });
        this.squawk(ctx, out, t, { delay: 0.2, freq: 340 * pitch, peak: 480, end: 280, dur: 0.1, gain: 0.25 });
        break;
      // Each kind of zombie has its own voice and feet, so you know what's coming before you see it.
      case 'hiss':
        // Sprinter: a raspy hiss with clicking in the throat.
        this.burst(ctx, out, t, { dur: 0.9, type: 'bandpass', freq: 3200 * pitch, to: 1800, q: 1.4, gain: 0.22 });
        for (let i = 0; i < 4; i++) this.burst(ctx, out, t, { dur: 0.025, type: 'bandpass', freq: 1500, q: 6, gain: 0.18, delay: 0.12 + i * 0.09 });
        break;
      case 'pant':
        // Runner: fast, wet panting.
        for (let i = 0; i < 4; i++) {
          this.burst(ctx, out, t, { dur: 0.13, type: 'bandpass', freq: (i % 2 ? 900 : 1300) * pitch, q: 1.2, gain: 0.2, delay: i * 0.17 });
          this.growl(ctx, out, t, { freq: 190 * pitch, end: 150, dur: 0.12, gain: 0.07, formant: 900, delay: i * 0.17 });
        }
        break;
      case 'roar':
        // Brute: a deep, long roar.
        this.growl(ctx, out, t, { freq: 62 * pitch, end: 42, dur: 1.6, gain: 0.4, formant: 360, q: 2 });
        this.growl(ctx, out, t, { freq: 94 * pitch, end: 60, dur: 1.4, gain: 0.16, formant: 600, delay: 0.05 });
        this.burst(ctx, out, t, { dur: 1.2, type: 'lowpass', freq: 500, gain: 0.12 });
        break;
      case 'bossRoar':
        this.growl(ctx, out, t, { freq: 48 * pitch, end: 34, dur: 2.2, gain: 0.45, formant: 300, q: 2, wobble: 4 });
        this.growl(ctx, out, t, { freq: 72 * pitch, end: 50, dur: 2, gain: 0.2, formant: 520, delay: 0.1 });
        this.tone(ctx, out, t, { dur: 1.8, type: 'sine', freq: 40, to: 30, gain: 0.25 });
        break;
      case 'zstepLight':
        this.burst(ctx, out, t, { dur: 0.05, type: 'bandpass', freq: 900 * pitch, q: 1.5, gain: 0.2 });
        this.burst(ctx, out, t, { dur: 0.04, type: 'highpass', freq: 3000, gain: 0.06 });
        break;
      case 'zstepHeavy':
        this.tone(ctx, out, t, { dur: 0.16, type: 'sine', freq: 58 * pitch, to: 34, gain: 0.42 });
        this.burst(ctx, out, t, { dur: 0.14, type: 'lowpass', freq: 260, gain: 0.35 });
        break;
      case 'zclaw':
        this.burst(ctx, out, t, { dur: 0.16, type: 'bandpass', freq: 2600 * pitch, to: 900, q: 1.1, gain: 0.3 });
        this.burst(ctx, out, t, { dur: 0.08, type: 'highpass', freq: 4000, gain: 0.08, delay: 0.03 });
        break;
      case 'zsmash':
        this.tone(ctx, out, t, { dur: 0.22, type: 'sine', freq: 90 * pitch, to: 40, gain: 0.45 });
        this.burst(ctx, out, t, { dur: 0.2, type: 'lowpass', freq: 700, gain: 0.4 });
        break;
      case 'zdeath':
        // A gurgling collapse, then the wet thump of it falling apart.
        this.growl(ctx, out, t, { freq: 120 * pitch, end: 45, dur: 0.8, gain: 0.25, formant: 600, wobble: 13 });
        this.burst(ctx, out, t, { dur: 0.25, type: 'lowpass', freq: 420, gain: 0.35, delay: 0.55 });
        this.burst(ctx, out, t, { dur: 0.3, type: 'bandpass', freq: 1400, q: 0.8, gain: 0.12, delay: 0.58 });
        break;
      case 'creak':
        this.growl(ctx, out, t, { freq: 58 * pitch, end: 44, dur: 0.9, gain: 0.14, formant: 950, q: 9, wobble: 9 });
        break;
      case 'pistol':
        this.burst(ctx, out, t, { dur: 0.018, type: 'highpass', freq: 3300 * pitch, gain: 0.7 });
        this.burst(ctx, out, t, { dur: 0.1, type: 'bandpass', freq: 1700 * pitch, to: 600, q: 0.7, gain: 1 });
        this.tone(ctx, out, t, { dur: 0.085, type: 'sine', freq: 175 * pitch, to: 55, gain: 0.72 });
        this.burst(ctx, out, t, { dur: 0.025, type: 'bandpass', freq: 2400 * pitch, q: 3, gain: 0.15, delay: 0.065 });
        break;
      case 'rifle':
        this.burst(ctx, out, t, { dur: 0.012, type: 'highpass', freq: 4100 * pitch, gain: 0.65 });
        this.burst(ctx, out, t, { dur: 0.105, type: 'bandpass', freq: 1150 * pitch, to: 420, q: 0.6, gain: 1 });
        this.tone(ctx, out, t, { dur: 0.09, type: 'triangle', freq: 145 * pitch, to: 48, gain: 0.5 });
        this.burst(ctx, out, t, { dur: 0.018, type: 'bandpass', freq: 2300 * pitch, q: 4, gain: 0.12, delay: 0.043 });
        break;
      case 'smg':
        this.burst(ctx, out, t, { dur: 0.012, type: 'highpass', freq: 4400 * pitch, gain: 0.45 });
        this.burst(ctx, out, t, { dur: 0.045, type: 'bandpass', freq: 2100 * pitch, to: 1000, q: 0.9, gain: 0.8 });
        this.tone(ctx, out, t, { dur: 0.05, type: 'sine', freq: 190 * pitch, to: 75, gain: 0.48 });
        break;
      case 'minigun':
        this.burst(ctx, out, t, { dur: 0.035, type: 'bandpass', freq: 1450 * pitch, to: 700, q: 0.8, gain: 0.7 });
        this.tone(ctx, out, t, { dur: 0.055, type: 'triangle', freq: 98 * pitch, to: 65, gain: 0.3 });
        break;
      case 'shotgun':
        this.burst(ctx, out, t, { dur: 0.035, type: 'highpass', freq: 2800 * pitch, gain: 0.8 });
        this.burst(ctx, out, t, { dur: 0.32, type: 'lowpass', freq: 1800 * pitch, to: 160, gain: 1.35 });
        this.tone(ctx, out, t, { dur: 0.18, type: 'sine', freq: 120 * pitch, to: 35, gain: 1 });
        this.burst(ctx, out, t, { dur: 0.065, type: 'bandpass', freq: 850 * pitch, to: 2200, q: 2, gain: 0.32, delay: 0.26 });
        this.burst(ctx, out, t, { dur: 0.04, type: 'highpass', freq: 2500, gain: 0.28, delay: 0.34 });
        break;
      case 'sniper':
        // Heavy: a sharp crack, a huge low boom, a rumbling tail, then the bolt worked.
        this.burst(ctx, out, t, { dur: 0.02, type: 'highpass', freq: 4200 * pitch, gain: 0.9 });
        this.burst(ctx, out, t, { dur: 0.07, type: 'bandpass', freq: 2200 * pitch, to: 700, q: 0.7, gain: 0.9 });
        this.burst(ctx, out, t, { dur: 0.7, type: 'lowpass', freq: 900 * pitch, to: 90, gain: 1.15 });
        this.tone(ctx, out, t, { dur: 0.4, type: 'sine', freq: 80 * pitch, to: 26, gain: 1.1 });
        this.burst(ctx, out, t, { dur: 0.3, type: 'bandpass', freq: 500, to: 200, q: 0.8, gain: 0.25, delay: 0.1 });
        this.bolt(ctx, out, t, 0.75, true);
        break;
      case 'scout':
        // Lighter and snappier than the sniper: a bright crack, a shorter boom, a quick bolt.
        this.burst(ctx, out, t, { dur: 0.018, type: 'highpass', freq: 4800 * pitch, gain: 0.9 });
        this.burst(ctx, out, t, { dur: 0.06, type: 'bandpass', freq: 2600 * pitch, to: 900, q: 0.8, gain: 0.85 });
        this.burst(ctx, out, t, { dur: 0.4, type: 'lowpass', freq: 1300 * pitch, to: 130, gain: 0.95 });
        this.tone(ctx, out, t, { dur: 0.22, type: 'sine', freq: 110 * pitch, to: 38, gain: 0.8 });
        this.bolt(ctx, out, t, 0.5, false);
        break;
      // Story events (Crystal Hunt).
      case 'hoot':
        // Monkey: rising hoots, then chatter.
        for (const [d, f] of [[0, 380], [0.18, 470], [0.34, 560]] as const) this.squawk(ctx, out, t, { delay: d, freq: f * pitch, peak: f * 1.5, end: f, dur: 0.15, gain: 0.25 });
        for (let i = 0; i < 4; i++) this.burst(ctx, out, t, { dur: 0.03, type: 'bandpass', freq: 2200, q: 5, gain: 0.15, delay: 0.55 + i * 0.06 });
        break;
      case 'monkeyShriek':
        // It has seen you: a piercing shriek.
        this.squawk(ctx, out, t, { delay: 0, freq: 900 * pitch, peak: 1900, end: 1300, dur: 0.55, gain: 0.3 });
        this.squawk(ctx, out, t, { delay: 0.05, freq: 1100 * pitch, peak: 2300, end: 1500, dur: 0.45, gain: 0.15 });
        break;
      case 'crystal':
        // A glassy chime with a shimmer.
        for (const [d, f] of [[0, 1047], [0.06, 1568], [0.12, 2093]] as const) this.tone(ctx, out, t, { dur: 0.6, type: 'sine', freq: f, gain: 0.18, delay: d });
        this.burst(ctx, out, t, { dur: 0.4, type: 'highpass', freq: 6000, gain: 0.05 });
        break;
      case 'portal':
        // A deep hum swelling, a rising whoosh.
        this.tone(ctx, out, t, { dur: 2, type: 'sine', freq: 70, to: 140, gain: 0.35 });
        this.swell(ctx, out, t, { dur: 2, freq: 300, to: 2200, q: 1.5, gain: 0.4 });
        break;
      case 'scareSting':
        // The scare: a sudden dissonant orchestra-like hit and a screech over it. A placeholder you
        // can swap for a file (see FILE_SOUNDS).
        for (const f of [196, 207.7, 277.2, 293.7]) this.tone(ctx, out, t, { dur: 1.4, type: 'sawtooth', freq: f, to: f * 0.97, gain: 0.12 });
        this.burst(ctx, out, t, { dur: 0.5, type: 'lowpass', freq: 900, to: 120, gain: 0.7 });
        this.tone(ctx, out, t, { dur: 0.6, type: 'sine', freq: 55, to: 30, gain: 0.6 });
        this.squawk(ctx, out, t, { delay: 0.02, freq: 1400, peak: 2600, end: 1800, dur: 0.9, gain: 0.16 });
        break;
      case 'buzz':
        // Fluorescent hum: mains buzz with a crackle (played over and over in the Backrooms).
        this.tone(ctx, out, t, { dur: 2.2, type: 'sawtooth', freq: 120, gain: 0.05 });
        this.tone(ctx, out, t, { dur: 2.2, type: 'square', freq: 240, gain: 0.015 });
        for (let i = 0; i < 3; i++) this.burst(ctx, out, t, { dur: 0.02, type: 'highpass', freq: 5000, gain: 0.04, delay: Math.random() * 2 });
        break;
      case 'splash':
        // A footstep in shallow water.
        this.burst(ctx, out, t, { dur: 0.18, type: 'bandpass', freq: 1300 * pitch, to: 500, q: 0.9, gain: 0.35 });
        this.burst(ctx, out, t, { dur: 0.08, type: 'highpass', freq: 3500, gain: 0.12, delay: 0.04 });
        break;
      case 'powerDown':
        // The power cutting out: everything winding down.
        this.tone(ctx, out, t, { dur: 1.3, type: 'sawtooth', freq: 240, to: 30, gain: 0.25 });
        this.burst(ctx, out, t, { dur: 0.15, type: 'bandpass', freq: 1600, q: 2, gain: 0.3 });
        break;
      case 'gurgle':
        // Exploder: wet bubbling in a swollen belly.
        for (let i = 0; i < 5; i++) this.tone(ctx, out, t, { dur: 0.09, type: 'sine', freq: (140 + Math.random() * 90) * pitch, to: 260, gain: 0.16, delay: i * 0.11 + Math.random() * 0.04 });
        this.burst(ctx, out, t, { dur: 0.6, type: 'lowpass', freq: 380, gain: 0.18 });
        break;
      case 'fuse':
        // The fuse: a hiss rising in pitch, faster and faster beeps (about 3/4 of a second).
        this.burst(ctx, out, t, { dur: 0.75, type: 'bandpass', freq: 1800, to: 5200, q: 2, gain: 0.25 });
        for (const d of [0, 0.25, 0.42, 0.55, 0.64, 0.7]) this.tone(ctx, out, t, { dur: 0.05, type: 'square', freq: 1500, gain: 0.08, delay: d });
        break;
      case 'powerUp':
        // A bright rising chime.
        for (const [d, f] of [[0, 660], [0.09, 880], [0.18, 1320]] as const) this.tone(ctx, out, t, { dur: 0.35, type: 'triangle', freq: f, gain: 0.22, delay: d });
        break;
      case 'nuke':
        // A deep far-off blast rolling away.
        this.tone(ctx, out, t, { dur: 1.6, type: 'sine', freq: 60, to: 24, gain: 0.7 });
        this.burst(ctx, out, t, { dur: 2.2, type: 'lowpass', freq: 600, to: 60, gain: 0.8 });
        break;
      case 'bloodMoon':
        // A distant bell tolling twice over a low swell (soft: it builds dread, it doesn't startle).
        for (const d of [0, 1.6]) {
          this.tone(ctx, out, t, { dur: 2.4, type: 'sine', freq: 196, to: 192, gain: 0.18, delay: d });
          this.tone(ctx, out, t, { dur: 2, type: 'sine', freq: 466, to: 460, gain: 0.06, delay: d });
        }
        this.swell(ctx, out, t, { dur: 4.5, freq: 160, to: 90, q: 1, gain: 0.35 });
        break;
      case 'reloadMag':
        // Magazine out, magazine in, charging handle.
        this.burst(ctx, out, t, { dur: 0.04, type: 'bandpass', freq: 1400, q: 3, gain: 0.35 });
        this.burst(ctx, out, t, { dur: 0.08, type: 'bandpass', freq: 600, q: 1.5, gain: 0.3, delay: 0.12 });
        this.burst(ctx, out, t, { dur: 0.05, type: 'bandpass', freq: 1000, q: 2.5, gain: 0.45, delay: 0.55 });
        this.tone(ctx, out, t, { dur: 0.06, type: 'sine', freq: 140, to: 80, gain: 0.25, delay: 0.55 });
        this.burst(ctx, out, t, { dur: 0.05, type: 'highpass', freq: 2400, gain: 0.35, delay: 0.95 });
        this.burst(ctx, out, t, { dur: 0.06, type: 'bandpass', freq: 1300, q: 3, gain: 0.4, delay: 1.05 });
        break;
      case 'reloadShell':
        // Shells pushed in one by one, then the pump.
        for (let i = 0; i < 3; i++) {
          this.burst(ctx, out, t, { dur: 0.04, type: 'bandpass', freq: 1700 + i * 100, q: 3, gain: 0.35, delay: i * 0.3 });
          this.tone(ctx, out, t, { dur: 0.04, type: 'triangle', freq: 300, to: 200, gain: 0.12, delay: i * 0.3 });
        }
        this.burst(ctx, out, t, { dur: 0.08, type: 'bandpass', freq: 800, to: 500, q: 1.5, gain: 0.4, delay: 1 });
        this.burst(ctx, out, t, { dur: 0.07, type: 'bandpass', freq: 1100, q: 2.5, gain: 0.45, delay: 1.2 });
        break;
      case 'reloadBolt':
        // Bolt up and back, rounds into the magazine, bolt forward and down.
        this.burst(ctx, out, t, { dur: 0.05, type: 'bandpass', freq: 1500, q: 4, gain: 0.35 });
        this.burst(ctx, out, t, { dur: 0.1, type: 'bandpass', freq: 800, to: 400, q: 1.5, gain: 0.3, delay: 0.05 });
        for (let i = 0; i < 3; i++) this.burst(ctx, out, t, { dur: 0.035, type: 'bandpass', freq: 2000, q: 4, gain: 0.3, delay: 0.5 + i * 0.28 });
        this.burst(ctx, out, t, { dur: 0.08, type: 'bandpass', freq: 1100, q: 3, gain: 0.45, delay: 1.6 });
        this.tone(ctx, out, t, { dur: 0.08, type: 'sine', freq: 140, to: 70, gain: 0.3, delay: 1.6 });
        break;
      case 'emptyHeavy':
        this.burst(ctx, out, t, { dur: 0.05, type: 'bandpass', freq: 900, q: 3, gain: 0.5 });
        this.tone(ctx, out, t, { dur: 0.05, type: 'sine', freq: 180, to: 90, gain: 0.25 });
        break;
      case 'rocket':
        this.tone(ctx, out, t, { dur: 0.12, type: 'sine', freq: 100 * pitch, to: 40, gain: 0.8 });
        this.burst(ctx, out, t, { dur: 0.5, type: 'bandpass', freq: 400, to: 1800, q: 1.5, gain: 1 });
        break;
      case 'revolver':
        this.burst(ctx, out, t, { dur: 0.16, type: 'lowpass', freq: 2600, to: 400, gain: 1.4 });
        this.tone(ctx, out, t, { dur: 0.14, type: 'sine', freq: 120, to: 45, gain: 1 });
        break;
      case 'battle':
        this.burst(ctx, out, t, { dur: 0.06, type: 'highpass', freq: 2200, gain: 0.8 });
        this.burst(ctx, out, t, { dur: 0.22, type: 'lowpass', freq: 1200, to: 180, gain: 1.2 });
        this.tone(ctx, out, t, { dur: 0.12, type: 'sine', freq: 110, to: 40, gain: 0.9 });
        break;
      case 'lmg':
        this.burst(ctx, out, t, { dur: 0.07, type: 'bandpass', freq: 900, q: 0.8, gain: 1 });
        this.tone(ctx, out, t, { dur: 0.07, type: 'sine', freq: 100, to: 45, gain: 0.7 });
        break;
      case 'crossbow':
        // The string's twang and the bolt leaving.
        this.tone(ctx, out, t, { dur: 0.16, type: 'triangle', freq: 190, to: 120, gain: 0.5 });
        this.burst(ctx, out, t, { dur: 0.1, type: 'highpass', freq: 3500, gain: 0.35 });
        break;
      case 'launcher':
        this.burst(ctx, out, t, { dur: 0.18, type: 'lowpass', freq: 700, to: 150, gain: 1.1 });
        this.tone(ctx, out, t, { dur: 0.12, type: 'sine', freq: 85, to: 40, gain: 1 });
        break;
      case 'deagle':
        // A heavy crack with a deep boom under it.
        this.burst(ctx, out, t, { dur: 0.05, type: 'highpass', freq: 2600, gain: 0.9 });
        this.burst(ctx, out, t, { dur: 0.24, type: 'lowpass', freq: 1800, to: 220, gain: 1.5 });
        this.tone(ctx, out, t, { dur: 0.18, type: 'sine', freq: 95, to: 38, gain: 1.1 });
        break;
      case 'silenced':
        // A soft cough and the slide clacking.
        this.burst(ctx, out, t, { dur: 0.07, type: 'bandpass', freq: 700, q: 1.1, gain: 0.45 });
        this.burst(ctx, out, t + 0.03, { dur: 0.03, type: 'highpass', freq: 4200, gain: 0.25 });
        break;
      // Melee swings: a filtered-noise whoosh sweeping down (quick and light, heavy, or long and ringing).
      case 'knife':
        this.burst(ctx, out, t, { dur: 0.16, type: 'bandpass', freq: 3200, to: 1100, q: 2.2, gain: 0.55 });
        break;
      case 'pan':
        this.burst(ctx, out, t, { dur: 0.26, type: 'bandpass', freq: 900, to: 300, q: 1.6, gain: 0.7 });
        break;
      case 'katana':
        this.burst(ctx, out, t, { dur: 0.22, type: 'bandpass', freq: 4200, to: 1400, q: 2.6, gain: 0.6 });
        this.tone(ctx, out, t, { dur: 0.3, type: 'sine', freq: 2600, to: 2400, gain: 0.05 });
        break;
      case 'meleeHit':
        this.burst(ctx, out, t, { dur: 0.09, type: 'lowpass', freq: 1800, to: 300, gain: 1.1 });
        this.tone(ctx, out, t, { dur: 0.08, type: 'sine', freq: 180, to: 70, gain: 0.6 });
        break;
      case 'beep':
        // The planted bomb.
        this.tone(ctx, out, t, { dur: 0.07, type: 'square', freq: 2050, gain: 0.12 });
        break;
      case 'bonk':
        // A frying pan on a chicken's head: a dull thud plus a metallic ring.
        this.tone(ctx, out, t, { dur: 0.06, type: 'sine', freq: 220, to: 90, gain: 0.9 });
        this.tone(ctx, out, t, { dur: 0.55, type: 'triangle', freq: 640, to: 610, gain: 0.35 });
        this.tone(ctx, out, t, { dur: 0.4, type: 'sine', freq: 1730, to: 1690, gain: 0.12 });
        break;
      case 'explosion':
        this.burst(ctx, out, t, { dur: 0.045, type: 'highpass', freq: 2600, gain: 0.7 });
        this.burst(ctx, out, t, { dur: 1.1, type: 'lowpass', freq: 1500, to: 80, gain: 1.8 });
        this.tone(ctx, out, t, { dur: 0.6, type: 'sine', freq: 70, to: 25, gain: 1.4 });
        this.burst(ctx, out, t, { dur: 0.4, type: 'bandpass', freq: 680, to: 130, gain: 0.25, delay: 0.18 });
        break;
      case 'hit':
        this.burst(ctx, out, t, { dur: 0.025, type: 'highpass', freq: 3000, gain: 0.13 });
        this.tone(ctx, out, t, { dur: 0.065, type: 'triangle', freq: 1450, to: 1100, gain: 0.23 });
        break;
      case 'headshot':
        this.tone(ctx, out, t, { dur: 0.08, type: 'triangle', freq: 1900, to: 1500, gain: 0.24 });
        this.tone(ctx, out, t, { dur: 0.12, type: 'sine', freq: 2850, gain: 0.16, delay: 0.035 });
        break;
      case 'kill':
        [880, 1320, 1760].forEach((f, i) => this.tone(ctx, out, t, { dur: 0.12, type: 'triangle', freq: f, gain: 0.3, delay: i * 0.07 }));
        break;
      case 'hurt':
        this.tone(ctx, out, t, { dur: 0.15, type: 'sine', freq: 220, to: 90, gain: 0.6 });
        this.burst(ctx, out, t, { dur: 0.1, type: 'lowpass', freq: 600, gain: 0.5 });
        break;
      case 'reload':
        this.burst(ctx, out, t, { dur: 0.04, type: 'highpass', freq: 2500, gain: 0.6 });
        this.burst(ctx, out, t, { dur: 0.05, type: 'highpass', freq: 1800, gain: 0.7, delay: 0.25 });
        break;
      case 'empty':
        this.burst(ctx, out, t, { dur: 0.03, type: 'highpass', freq: 3000, gain: 0.4 });
        break;
      case 'switch':
      case 'equip':
        this.burst(ctx, out, t, { dur: 0.05, type: 'bandpass', freq: 2200, gain: 0.4 });
        break;
      case 'sniperZoom':
        // A short mechanical click-whirr.
        this.burst(ctx, out, t, { dur: 0.04, type: 'highpass', freq: 3500, gain: 0.35 });
        this.tone(ctx, out, t, { dur: 0.12, type: 'triangle', freq: 900, to: 1500, gain: 0.08, delay: 0.02 });
        break;
      case 'jump':
        this.tone(ctx, out, t, { dur: 0.08, type: 'triangle', freq: 600, to: 950, gain: 0.25 });
        break;
      case 'jet':
        this.burst(ctx, out, t, { dur: 0.14, type: 'bandpass', freq: 700, q: 0.7, gain: 0.4 });
        break;
      case 'throw':
        this.burst(ctx, out, t, { dur: 0.18, type: 'bandpass', freq: 800, to: 2000, q: 2, gain: 0.5 });
        break;
      case 'shellClink':
        // A brass case hitting the floor: a bright tink and its ring.
        this.tone(ctx, out, t, { dur: 0.09, type: 'triangle', freq: 4300 + Math.random() * 600, to: 3900, gain: 0.16 });
        this.tone(ctx, out, t, { dur: 0.05, type: 'sine', freq: 6400 + Math.random() * 500, gain: 0.07, delay: 0.004 });
        break;
      case 'shellThud':
        // A plastic shotgun shell: a hollow tock.
        this.tone(ctx, out, t, { dur: 0.06, type: 'triangle', freq: 1100 + Math.random() * 200, to: 700, gain: 0.18 });
        this.burst(ctx, out, t, { dur: 0.03, type: 'bandpass', freq: 2400, q: 2, gain: 0.2 });
        break;
      case 'pin':
        // The pin pulled: a metal click and the ring's little ping.
        this.burst(ctx, out, t, { dur: 0.03, type: 'highpass', freq: 4200, gain: 0.5 });
        this.tone(ctx, out, t, { dur: 0.14, type: 'triangle', freq: 2600, to: 2300, gain: 0.12, delay: 0.02 });
        this.burst(ctx, out, t, { dur: 0.04, type: 'bandpass', freq: 1800, q: 3, gain: 0.3, delay: 0.09 });
        break;
      case 'pickup':
        [660, 880, 1100].forEach((f, i) => this.tone(ctx, out, t, { dur: 0.09, type: 'sine', freq: f, gain: 0.35, delay: i * 0.06 }));
        break;
      case 'death':
        // "BA-WAWK!" and a thud as it hits the ground, with a flurry of feathers.
        this.squawk(ctx, out, t, { delay: 0, freq: 780, peak: 1250, end: 520, dur: 0.16, gain: 0.32 });
        this.squawk(ctx, out, t, { delay: 0.17, freq: 900, peak: 1500, end: 380, dur: 0.34, gain: 0.36 });
        this.burst(ctx, out, t, { dur: 0.35, type: 'highpass', freq: 3500, gain: 0.18, delay: 0.05 });
        this.tone(ctx, out, t, { dur: 0.18, type: 'sine', freq: 130, to: 45, gain: 0.7, delay: 0.5 });
        this.burst(ctx, out, t, { dur: 0.12, type: 'lowpass', freq: 500, gain: 0.5, delay: 0.5 });
        break;
      case 'poof':
        this.burst(ctx, out, t, { dur: 0.35, type: 'bandpass', freq: 1800, to: 400, q: 0.8, gain: 0.6 });
        this.tone(ctx, out, t, { dur: 0.12, type: 'sine', freq: 520, to: 1400, gain: 0.25 });
        break;
      case 'boxBreak':
        this.burst(ctx, out, t, { dur: 0.25, type: 'bandpass', freq: 900, q: 0.6, gain: 0.8 });
        this.tone(ctx, out, t, { dur: 0.15, type: 'triangle', freq: 1200, to: 1800, gain: 0.15 });
        break;
      case 'smokePop':
        this.burst(ctx, out, t, { dur: 0.9, type: 'lowpass', freq: 2500, to: 300, gain: 0.7 });
        break;
      case 'click':
        this.tone(ctx, out, t, { dur: 0.04, type: 'sine', freq: 900, gain: 0.2 });
        break;
      case 'reward':
        [523, 659, 784, 1046].forEach((f, i) => this.tone(ctx, out, t, { dur: 0.16, type: 'triangle', freq: f, gain: 0.3, delay: i * 0.09 }));
        break;
      case 'countdown':
        this.tone(ctx, out, t, { dur: 0.12, type: 'sine', freq: 740, gain: 0.3 });
        break;
      case 'keypad':
        // A key going in on the bomb.
        this.tone(ctx, out, t, { dur: 0.06, type: 'square', freq: 1500 + Math.random() * 600, gain: 0.12 });
        break;
      case 'defuseTick':
        // Wire cutters at work.
        this.burst(ctx, out, t, { dur: 0.03, type: 'highpass', freq: 4200, gain: 0.45 });
        break;
      case 'bombPlanted':
        // A two-tone alarm, three times.
        for (let i = 0; i < 3; i++) {
          this.tone(ctx, out, t, { dur: 0.16, type: 'square', freq: 880, gain: 0.12, delay: i * 0.36 });
          this.tone(ctx, out, t, { dur: 0.16, type: 'square', freq: 660, gain: 0.12, delay: i * 0.36 + 0.18 });
        }
        break;
      case 'defused':
        [520, 660, 880].forEach((f, i) => this.tone(ctx, out, t, { dur: 0.14, type: 'triangle', freq: f, gain: 0.25, delay: i * 0.1 }));
        break;
      case 'bigBoom':
        // A crack, a long low rumble and debris.
        this.burst(ctx, out, t, { dur: 0.12, type: 'highpass', freq: 2400, gain: 1.4 });
        this.burst(ctx, out, t, { dur: 1.8, type: 'lowpass', freq: 900, to: 60, gain: 1.8 });
        this.tone(ctx, out, t, { dur: 1.4, type: 'sine', freq: 58, to: 24, gain: 1.4 });
        this.burst(ctx, out, t, { dur: 0.8, type: 'bandpass', freq: 500, q: 0.8, gain: 0.5, delay: 0.25 });
        break;
      case 'flashbang':
        // A sharp crack and a thump.
        this.burst(ctx, out, t, { dur: 0.08, type: 'highpass', freq: 3000, gain: 1.6 });
        this.burst(ctx, out, t, { dur: 0.3, type: 'lowpass', freq: 1400, to: 200, gain: 1.4 });
        this.tone(ctx, out, t, { dur: 0.2, type: 'sine', freq: 120, to: 45, gain: 0.9 });
        break;
      case 'ring':
        // Ears ringing after a flash, dying away over the white-out.
        this.tone(ctx, out, t, { dur: this.ringSeconds, type: 'sine', freq: 3150, to: 2900, gain: 0.09 });
        this.tone(ctx, out, t, { dur: this.ringSeconds * 0.8, type: 'sine', freq: 4400, to: 4200, gain: 0.035 });
        break;
      case 'scream':
        // Jumpscare: a long screeching, wobbling chicken scream (several overlapping squawks).
        this.squawk(ctx, out, t, { delay: 0, freq: 700, peak: 1500, end: 1100, dur: 0.7, gain: 0.7 });
        this.squawk(ctx, out, t, { delay: 0.02, freq: 960, peak: 1900, end: 1300, dur: 0.7, gain: 0.5 });
        this.squawk(ctx, out, t, { delay: 0.4, freq: 1100, peak: 2100, end: 1500, dur: 0.7, gain: 0.6 });
        this.squawk(ctx, out, t, { delay: 0.8, freq: 1300, peak: 1800, end: 500, dur: 0.9, gain: 0.6 });
        this.burst(ctx, out, t, { dur: 1.6, type: 'bandpass', freq: 2600, to: 1200, q: 2, gain: 0.9 });
        break;
      case 'scareHit':
        // The jumpscare's slam: a sub-bass drop, a thud and a crack.
        this.tone(ctx, out, t, { dur: 1.1, type: 'sine', freq: 75, to: 24, gain: 1.8 });
        this.burst(ctx, out, t, { dur: 0.7, type: 'lowpass', freq: 1400, to: 70, gain: 1.6 });
        this.burst(ctx, out, t, { dur: 0.12, type: 'highpass', freq: 2600, gain: 1.2 });
        this.tone(ctx, out, t, { dur: 0.9, type: 'sawtooth', freq: 140, to: 70, gain: 0.35 });
        break;
      case 'glassCrack':
        // The screen cracking: a sharp snap and a few splinters.
        this.burst(ctx, out, t, { dur: 0.22, type: 'highpass', freq: 4200, gain: 1.4 });
        this.burst(ctx, out, t, { dur: 0.08, type: 'bandpass', freq: 6500, q: 3, gain: 1, delay: 0.04 });
        this.burst(ctx, out, t, { dur: 0.06, type: 'bandpass', freq: 5200, q: 3, gain: 0.8, delay: 0.09 });
        this.burst(ctx, out, t, { dur: 0.05, type: 'bandpass', freq: 7400, q: 3, gain: 0.6, delay: 0.15 });
        break;
      case 'wail':
        // A ghost's scream: high and falling, with a hollow breathy layer.
        this.tone(ctx, out, t, { dur: 1.7, type: 'sine', freq: 1400, to: 380, gain: 0.55 });
        this.tone(ctx, out, t, { dur: 1.6, type: 'triangle', freq: 1480, to: 420, gain: 0.35 });
        this.squawk(ctx, out, t, { delay: 0, freq: 900, peak: 1600, end: 400, dur: 1.4, gain: 0.45 });
        this.burst(ctx, out, t, { dur: 1.7, type: 'bandpass', freq: 1800, to: 500, q: 3, gain: 0.8 });
        break;
      case 'giggle':
        // funnyChiken: a creepy rising-and-falling "hee hee hee" giggle, then a long breathy laugh.
        for (let i = 0; i < 7; i++) {
          const f = 980 + (i % 2) * 160 - i * 40;
          this.squawk(ctx, out, t, { delay: i * 0.13, freq: f, peak: f * 1.35, end: f * 0.8, dur: 0.11, gain: 0.55 });
        }
        this.squawk(ctx, out, t, { delay: 0.95, freq: 900, peak: 1400, end: 380, dur: 0.75, gain: 0.5 });
        this.burst(ctx, out, t, { dur: 0.8, type: 'bandpass', freq: 1600, to: 600, q: 2, gain: 0.5, delay: 0.95 });
        break;
      case 'heartbeat':
        // Lub-dub, twice.
        for (const [d, f] of [[0, 62], [0.2, 52], [0.75, 62], [0.95, 52]] as const) this.tone(ctx, out, t, { dur: 0.16, type: 'sine', freq: f, to: 38, gain: 1.4, delay: d });
        break;
      case 'static':
        // Jumpscare: TV static and a deep wrong hum.
        this.burst(ctx, out, t, { dur: 1.5, type: 'highpass', freq: 900, gain: 1.1 });
        this.tone(ctx, out, t, { dur: 1.5, type: 'square', freq: 55, to: 40, gain: 0.35 });
        this.squawk(ctx, out, t, { delay: 0.1, freq: 400, peak: 2200, end: 300, dur: 1.2, gain: 0.55 });
        break;
      case 'engine':
        this.tone(ctx, out, t, { dur: 0.12, type: 'sawtooth', freq: 70, to: 80, gain: 0.12 });
        break;
    }
  }
}
