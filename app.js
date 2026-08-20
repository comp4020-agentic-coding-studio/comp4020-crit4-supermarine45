"use strict";

/* ============================================================
   Constellation Jam Station
   Sharing one Web Audio graph and one master clock:
     1. A looping drum backing track (8x4 step sequencer, driven by a
        lookahead scheduler locked to the BPM/Swing sliders).
     2. The Constellation Looper: clicking the canvas drops a "star" that
        lives forever and retriggers every bar, exactly when the sweeping
        playhead crosses its X position. Its Y position is scale-quantized.
     3. The Live Piano: a solo instrument played from three physical
        keyboard rows, 30 keys total (Z-X-C-V-B-N-M-,-.-/ lowest,
        A-S-D-F-G-H-J-K-L-; middle, Q-W-E-R-T-Y-U-I-O-P highest), or their
        on-screen twins. Piano notes are intentionally NOT quantized in
        time - only in pitch - so playing over the loop stays a free,
        expressive gesture (timing feel is a big part of "two people sound
        different") while still guaranteeing every note is harmonically
        safe (Chromatic scale excepted - that's an explicit, deliberate
        opt-out).
     4. Two loop pedals (piano + a live GarageBand-style drum Kit) that
        capture a take; finishing a recording hands it to the Loop Library
        below rather than looping it forever by itself.
     5. Backing Styles: each real licensed recording (Big Band, Swing,
        Samba, ...) is pre-loaded as a PAIR of permanent Loop Library
        clips - a long excerpt auto-trimmed to a beat boundary and
        resampled live to the BPM slider, plus the untouched full
        recording as a "(Live)" alternative that loops at its own native
        speed instead.
     6. The Loop Library + Track Deck: a Loopy HD/GarageBand-style setup
        where every recording, Style, and voice take is a draggable clip
        card, and a fixed set of independent per-track loopers each play
        whatever clip is loaded on them, forever, at that clip's own
        length - with no shared song timeline - so the performer "arranges"
        a piece live by swapping what's loaded on each track over time.
     7. Voice recording (mic input via getUserMedia/MediaRecorder) adds a
        new kind of Loop Library clip alongside piano/drum/style ones.
   ============================================================ */

// ============================================================
// 1. SCALE QUANTIZATION
// ============================================================

// Semitone offsets from C. Root is fixed at C; the dropdown swaps which
// interval set is active. Two tables are derived from this whenever the
// scale (or the piano's Octave slider) changes: KB_FREQS, one entry per
// physical piano key, and CANVAS_NOTE_TABLE, a denser multi-octave table
// used for the canvas's continuous Y-axis.
const SCALES = {
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  // All 12 semitones - the one deliberate opt-out of the "no wrong notes"
  // guarantee. It only takes effect when the user explicitly picks it.
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

function noteFreq(semitoneFromC, octave) {
  const midi = (octave + 1) * 12 + semitoneFromC;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

let currentScale = "majorPentatonic";
let octaveShift = 0; // -2..+2, from the Octave slider; applied only to the piano, not the canvas

// The piano is styled to look like a real black/white-key instrument. Which
// keys are "black" is driven by the actual semitone the scale assigns them
// (C#,D#,F#,G#,A#), not a fixed position - so Chromatic renders the full
// piano pattern, an all-natural scale like Major Pentatonic renders as all
// white keys, and scales with a couple of accidentals (Blues, Dorian, ...)
// show black keys in exactly the musically-correct spots.
const BLACK_KEY_SEMITONES = new Set([1, 3, 6, 8, 10]);

// The live piano spans three physical keyboard rows so it has real range:
// the bottom row is the lowest register, continuing seamlessly (low to
// high) up through the home row and into the top QWERTYUIOP row as the
// highest register. Concatenated, that's 30 keys total instead of 10.
const LEFT_HAND_KEYS = ["KeyZ", "KeyX", "KeyC", "KeyV", "KeyB", "KeyN", "KeyM", "Comma", "Period", "Slash"];
const LEFT_HAND_LABELS = ["Z", "X", "C", "V", "B", "N", "M", ",", ".", "/"];
const RIGHT_HAND_KEYS = ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon"];
const RIGHT_HAND_LABELS = ["A", "S", "D", "F", "G", "H", "J", "K", "L", ";"];
const TOP_HAND_KEYS = ["KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP"];
const TOP_HAND_LABELS = ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"];
const KB_KEYS = [...LEFT_HAND_KEYS, ...RIGHT_HAND_KEYS, ...TOP_HAND_KEYS];
const KB_LABELS = [...LEFT_HAND_LABELS, ...RIGHT_HAND_LABELS, ...TOP_HAND_LABELS];
let KB_FREQS = []; // one frequency per KB_KEYS entry - see rebuildScaleTables()

let CANVAS_NOTE_TABLE = []; // ascending low->high, spans 3 octaves, for the canvas Y-axis

function rebuildScaleTables() {
  const intervals = SCALES[currentScale];
  const octaveMultiplier = Math.pow(2, octaveShift);

  // KB_FREQS: map all 20 physical/visual keys (both hand-rows) onto scale
  // degrees in one continuous ascending run, with NO repeats (or, for
  // Chromatic, all 12 semitones). Because scales have 5-12 degrees but
  // there are 20 keys, degrees wrap into higher octaves as needed - every
  // key still lands exactly on a scale tone, just one or more octaves up,
  // so mashing either hand's row is always in key. The Octave slider then
  // shifts every one of those frequencies by the same power-of-two
  // multiplier.
  KB_FREQS = KB_KEYS.map((_, i) => {
    const degree = i % intervals.length;
    const octave = 4 + Math.floor(i / intervals.length);
    return noteFreq(intervals[degree], octave) * octaveMultiplier;
  });

  // CANVAS_NOTE_TABLE: a finer-grained table for the canvas's continuous
  // Y-axis, independent of both the keyboard's 10 fixed slots and the
  // Octave slider (the constellation lives at its own fixed register).
  CANVAS_NOTE_TABLE = [];
  for (let octave = 3; octave <= 5; octave++) {
    for (const iv of intervals) CANVAS_NOTE_TABLE.push(noteFreq(iv, octave));
  }

  // Mark each key that lands on the scale's tonic (degree 0) as a visual
  // anchor, and classify it as a black/white piano key by its real semitone.
  // Nothing is ever disabled - every key is already scale-safe by
  // construction - both markings are purely orientation, not gatekeeping.
  pianoKeyElements.forEach((key, i) => {
    const degree = i % intervals.length;
    key.classList.toggle("root", degree === 0);
    key.classList.toggle("black-key", BLACK_KEY_SEMITONES.has(intervals[degree]));
  });
}

// y=0 (top) is the highest note, y=height (bottom) is the lowest - flipped
// before indexing, then floored into one exact table entry. This is the
// "no wrong notes" guarantee for canvas input: every pixel row rounds down
// to a single scale tone, never anything between two tones.
function quantizeCanvasY(yRatio) {
  const pitchRatio = 1 - Math.max(0, Math.min(1, yRatio));
  const index = Math.min(CANVAS_NOTE_TABLE.length - 1, Math.floor(pitchRatio * CANVAS_NOTE_TABLE.length));
  return CANVAS_NOTE_TABLE[index];
}

// ============================================================
// 2. SYNTH PATCHES
// ============================================================
// Every builder has the signature (freq, startTime) -> { release() }.
// startTime is an audioContext.currentTime-based timestamp - "now" for
// live piano input, or an exact future instant for a scheduled
// Constellation star - so the same patch code serves both live and
// looped notes with sample-accurate attacks either way. release() always
// acts relative to the real "now" at the moment it is called, which is
// exactly right for live key-up, and close enough (a few ms of setTimeout
// jitter) for a star's short scheduled tail.

let currentPatch = "pluck";

// Pluck Synth - a sawtooth through a lowpass filter whose cutoff snaps
// down fast: a plucked/synth-pluck's harmonics decay faster than its
// amplitude, which is what reads as "pluck" rather than "organ."
function buildPluckSynth(freq, startTime) {
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.value = freq;

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 6;
  filter.frequency.setValueAtTime(4500, startTime);
  filter.frequency.exponentialRampToValueAtTime(300, startTime + 0.25);

  const ampEnv = ctx.createGain();
  ampEnv.gain.setValueAtTime(0, startTime);
  ampEnv.gain.linearRampToValueAtTime(0.5, startTime + 0.005); // near-instant pluck attack
  ampEnv.gain.linearRampToValueAtTime(0.16, startTime + 0.2);  // settles to a quiet sustain while held

  osc.connect(filter);
  filter.connect(ampEnv);
  ampEnv.connect(preMaster);
  osc.start(startTime);

  return {
    release() {
      const t = ctx.currentTime;
      const releaseTime = 0.15;
      ampEnv.gain.cancelScheduledValues(t);
      ampEnv.gain.setValueAtTime(ampEnv.gain.value, t);
      ampEnv.gain.exponentialRampToValueAtTime(0.0001, t + releaseTime);
      osc.stop(t + releaseTime + 0.05);
      osc.onended = () => { osc.disconnect(); filter.disconnect(); ampEnv.disconnect(); };
    },
  };
}

// Electric Piano - 2-operator FM synthesis. A modulator oscillator drives
// a GainNode (the "modulation index," in Hz of frequency deviation) that
// feeds directly into the carrier oscillator's frequency AudioParam. A
// high initial index gives the bright, bell-like attack real FM electric
// pianos are known for; ramping the index down mellows the tone into a
// warmer sustain without touching the amplitude envelope at all.
function buildElectricPiano(freq, startTime) {
  const carrier = ctx.createOscillator();
  carrier.type = "sine";
  carrier.frequency.value = freq;

  const modulator = ctx.createOscillator();
  modulator.type = "sine";
  modulator.frequency.value = freq * 2; // 2:1 carrier:modulator ratio - a bell-like FM timbre

  const modGain = ctx.createGain();
  modGain.gain.setValueAtTime(freq * 3, startTime);
  modGain.gain.exponentialRampToValueAtTime(Math.max(1, freq * 0.3), startTime + 0.4);

  modulator.connect(modGain);
  modGain.connect(carrier.frequency); // FM: modulator output adds to the carrier's instantaneous frequency

  const ampEnv = ctx.createGain();
  ampEnv.gain.setValueAtTime(0, startTime);
  ampEnv.gain.linearRampToValueAtTime(0.5, startTime + 0.01);
  ampEnv.gain.linearRampToValueAtTime(0.26, startTime + 0.3);

  carrier.connect(ampEnv);
  ampEnv.connect(preMaster);
  carrier.start(startTime);
  modulator.start(startTime);

  return {
    release() {
      const t = ctx.currentTime;
      const releaseTime = 0.4;
      ampEnv.gain.cancelScheduledValues(t);
      ampEnv.gain.setValueAtTime(ampEnv.gain.value, t);
      ampEnv.gain.exponentialRampToValueAtTime(0.0001, t + releaseTime);
      carrier.stop(t + releaseTime + 0.05);
      modulator.stop(t + releaseTime + 0.05);
      carrier.onended = () => { carrier.disconnect(); modulator.disconnect(); modGain.disconnect(); ampEnv.disconnect(); };
    },
  };
}

// Marimba - a sine "body" tuned to the note, plus a very brief, slightly
// inharmonic higher partial (~4x frequency, gone within 50ms) standing in
// for the mallet's attack "click." Real marimba tones decay on their own
// regardless of how long the mallet contacts the bar, so there is
// deliberately no sustain plateau here - the body simply rings out.
function buildMarimba(freq, startTime) {
  const body = ctx.createOscillator();
  body.type = "sine";
  body.frequency.value = freq;

  const click = ctx.createOscillator();
  click.type = "sine";
  click.frequency.value = freq * 3.98; // near-4x but not exact - avoids a too-clean, too-digital overtone

  const bodyEnv = ctx.createGain();
  bodyEnv.gain.setValueAtTime(0, startTime);
  bodyEnv.gain.linearRampToValueAtTime(0.6, startTime + 0.004);
  bodyEnv.gain.exponentialRampToValueAtTime(0.001, startTime + 0.9); // natural decay, independent of key-hold

  const clickEnv = ctx.createGain();
  clickEnv.gain.setValueAtTime(0, startTime);
  clickEnv.gain.linearRampToValueAtTime(0.22, startTime + 0.002);
  clickEnv.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.05);

  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 5000; // tames aliasing harshness from the click partial

  body.connect(bodyEnv);
  click.connect(clickEnv);
  bodyEnv.connect(tone);
  clickEnv.connect(tone);
  tone.connect(preMaster);

  body.start(startTime);
  click.start(startTime);
  body.stop(startTime + 1.0);
  click.stop(startTime + 0.1);
  body.onended = () => { body.disconnect(); click.disconnect(); bodyEnv.disconnect(); clickEnv.disconnect(); tone.disconnect(); };

  return {
    release() {
      // The tone is already decaying on its own; an early release just
      // shortens whatever tail is left rather than driving a fresh stage.
      const t = ctx.currentTime;
      bodyEnv.gain.cancelScheduledValues(t);
      bodyEnv.gain.setValueAtTime(bodyEnv.gain.value, t);
      bodyEnv.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    },
  };
}

// Upright Bass - two slightly detuned triangle oscillators (for body/
// width) through a lowpass filter whose cutoff softens right after the
// attack, mimicking a plucked string's articulation. Bass patches
// conventionally sound an octave below what's played, so the incoming
// frequency is halved here rather than in the shared voice engine.
function buildUprightBass(freq, startTime) {
  const bassFreq = freq / 2;

  const osc1 = ctx.createOscillator();
  osc1.type = "triangle";
  osc1.frequency.value = bassFreq;

  const osc2 = ctx.createOscillator();
  osc2.type = "triangle";
  osc2.frequency.value = bassFreq * 1.004; // slight detune for a fuller, less sterile body

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 1.2;
  filter.frequency.setValueAtTime(1200, startTime);
  filter.frequency.exponentialRampToValueAtTime(500, startTime + 0.15);

  const ampEnv = ctx.createGain();
  ampEnv.gain.setValueAtTime(0, startTime);
  ampEnv.gain.linearRampToValueAtTime(0.55, startTime + 0.015);
  ampEnv.gain.linearRampToValueAtTime(0.32, startTime + 0.2); // settles to sustain while held

  const mix = ctx.createGain();
  mix.gain.value = 0.5;

  osc1.connect(mix);
  osc2.connect(mix);
  mix.connect(filter);
  filter.connect(ampEnv);
  ampEnv.connect(preMaster);
  osc1.start(startTime);
  osc2.start(startTime);

  return {
    release() {
      const t = ctx.currentTime;
      const releaseTime = 0.25;
      ampEnv.gain.cancelScheduledValues(t);
      ampEnv.gain.setValueAtTime(ampEnv.gain.value, t);
      ampEnv.gain.exponentialRampToValueAtTime(0.0001, t + releaseTime);
      osc1.stop(t + releaseTime + 0.05);
      osc2.stop(t + releaseTime + 0.05);
      osc1.onended = () => { osc1.disconnect(); osc2.disconnect(); filter.disconnect(); ampEnv.disconnect(); mix.disconnect(); };
    },
  };
}

// FM Brass - carrier and modulator at a 1:1 ratio (the classic FM-brass
// buzz), but unlike the Electric Piano, the modulation index RISES over
// the first ~90ms rather than falling. That rising index is the "brass
// swell": a real horn's tone brightens as the player's air pressure and
// embouchure firm up into the note, and FM brass patches fake that swell
// purely by animating the modulation index alongside the amplitude.
function buildFMBrass(freq, startTime) {
  const carrier = ctx.createOscillator();
  carrier.type = "sine";
  carrier.frequency.value = freq;

  const modulator = ctx.createOscillator();
  modulator.type = "sine";
  modulator.frequency.value = freq;

  const modGain = ctx.createGain();
  modGain.gain.setValueAtTime(0, startTime);
  modGain.gain.linearRampToValueAtTime(freq * 2.2, startTime + 0.09);

  modulator.connect(modGain);
  modGain.connect(carrier.frequency);

  const ampEnv = ctx.createGain();
  ampEnv.gain.setValueAtTime(0, startTime);
  ampEnv.gain.linearRampToValueAtTime(0.45, startTime + 0.09); // slower attack than the plucked patches, matching the swell
  ampEnv.gain.linearRampToValueAtTime(0.3, startTime + 0.25);

  carrier.connect(ampEnv);
  ampEnv.connect(preMaster);
  carrier.start(startTime);
  modulator.start(startTime);

  return {
    release() {
      const t = ctx.currentTime;
      const releaseTime = 0.2;
      ampEnv.gain.cancelScheduledValues(t);
      ampEnv.gain.setValueAtTime(ampEnv.gain.value, t);
      ampEnv.gain.exponentialRampToValueAtTime(0.0001, t + releaseTime);
      modGain.gain.cancelScheduledValues(t);
      modGain.gain.setValueAtTime(modGain.gain.value, t);
      modGain.gain.linearRampToValueAtTime(0, t + releaseTime);
      carrier.stop(t + releaseTime + 0.05);
      modulator.stop(t + releaseTime + 0.05);
      carrier.onended = () => { carrier.disconnect(); modulator.disconnect(); modGain.disconnect(); ampEnv.disconnect(); };
    },
  };
}

// Pad - three sawtooths spread across a few cents of detune (chorused
// width), through a lowpass filter that itself opens slowly over ~1.4s.
// Both the filter sweep and the slow amplitude attack/release are what
// make a "pad": the sound blooms in and dissolves out rather than
// striking, which is why it stays musical even under a slow, sparse loop.
function buildPad(freq, startTime) {
  const detuneCents = [-24, 0, 28];
  const oscs = detuneCents.map((cents) => {
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = freq;
    o.detune.value = cents;
    return o;
  });

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.8;
  filter.frequency.setValueAtTime(200, startTime);
  filter.frequency.linearRampToValueAtTime(2200, startTime + 1.4);

  const ampEnv = ctx.createGain();
  ampEnv.gain.setValueAtTime(0, startTime);
  ampEnv.gain.linearRampToValueAtTime(0.32, startTime + 0.7); // slow attack - the note blooms in rather than striking

  const mix = ctx.createGain();
  mix.gain.value = 1 / oscs.length;

  oscs.forEach((o) => { o.connect(mix); o.start(startTime); });
  mix.connect(filter);
  filter.connect(ampEnv);
  ampEnv.connect(preMaster);

  return {
    release() {
      const t = ctx.currentTime;
      const releaseTime = 1.1; // slow release to match the slow attack
      ampEnv.gain.cancelScheduledValues(t);
      ampEnv.gain.setValueAtTime(ampEnv.gain.value, t);
      ampEnv.gain.linearRampToValueAtTime(0.0001, t + releaseTime);
      oscs.forEach((o) => o.stop(t + releaseTime + 0.05));
      oscs[0].onended = () => { oscs.forEach((o) => o.disconnect()); mix.disconnect(); filter.disconnect(); ampEnv.disconnect(); };
    },
  };
}

// Classical Grand Piano - an additive stack of sine partials (a struck
// string modeled as a fundamental plus overtones), each decaying at its
// own rate with higher partials dying out faster than the fundamental -
// the same "natural decay independent of key-hold" model as the Marimba
// above, just with more partials. Ratios are nudged slightly sharp of
// exact integers (2.01, 3.03...) for string-stiffness inharmonicity, and
// a brief bandpass-filtered noise burst stands in for the hammer strike.
function buildGrandPiano(freq, startTime) {
  const partials = [
    { mult: 1, amp: 0.5, decay: 2.6 },
    { mult: 2.01, amp: 0.28, decay: 1.8 },
    { mult: 3.03, amp: 0.16, decay: 1.2 },
    { mult: 4.06, amp: 0.1, decay: 0.8 },
    { mult: 5.1, amp: 0.05, decay: 0.5 },
  ];

  const voiceGain = ctx.createGain();
  voiceGain.gain.value = 1;
  voiceGain.connect(preMaster);

  const oscs = [];
  const envs = [];
  partials.forEach(({ mult, amp, decay }) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq * mult;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, startTime);
    env.gain.linearRampToValueAtTime(amp, startTime + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + decay); // natural decay, independent of key-hold - like Marimba

    osc.connect(env);
    env.connect(voiceGain);
    osc.start(startTime);
    osc.stop(startTime + decay + 0.1);
    oscs.push(osc);
    envs.push(env);
  });

  // Hammer strike: a ~18ms burst of bandpass-filtered noise, brighter for
  // higher notes (a hard hammer hitting a shorter, tauter string).
  const hammer = ctx.createBufferSource();
  hammer.buffer = noiseBuffer;
  const hammerFilter = ctx.createBiquadFilter();
  hammerFilter.type = "bandpass";
  hammerFilter.frequency.value = Math.min(freq * 2.5, 8000);
  hammerFilter.Q.value = 0.7;
  const hammerEnv = ctx.createGain();
  hammerEnv.gain.setValueAtTime(0, startTime);
  hammerEnv.gain.linearRampToValueAtTime(0.35, startTime + 0.002);
  hammerEnv.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.018);
  hammer.connect(hammerFilter);
  hammerFilter.connect(hammerEnv);
  hammerEnv.connect(voiceGain);
  const hammerOffset = Math.random() * (noiseBuffer.duration - 0.05);
  hammer.start(startTime, hammerOffset);
  hammer.stop(startTime + 0.03);

  oscs[0].onended = () => {
    oscs.forEach((o) => o.disconnect());
    envs.forEach((e) => e.disconnect());
    hammer.disconnect();
    hammerFilter.disconnect();
    hammerEnv.disconnect();
    voiceGain.disconnect();
  };

  return {
    release() {
      // Each partial is already decaying on its own; an early release just
      // imposes a short damper-fall so key-up cuts the string ring short
      // rather than letting the full natural decay play out.
      const t = ctx.currentTime;
      const damperTime = 0.15;
      envs.forEach((env) => {
        env.gain.cancelScheduledValues(t);
        env.gain.setValueAtTime(env.gain.value, t);
        env.gain.exponentialRampToValueAtTime(0.0001, t + damperTime);
      });
    },
  };
}

const PATCH_BUILDERS = {
  pluck: buildPluckSynth,
  epiano: buildElectricPiano,
  marimba: buildMarimba,
  bass: buildUprightBass,
  fmbrass: buildFMBrass,
  pad: buildPad,
  grandPiano: buildGrandPiano,
};
const PATCH_COLORS = {
  pluck: "#f5a623",
  epiano: "#22d3ee",
  marimba: "#7ee787",
  bass: "#ff5c72",
  fmbrass: "#ff9f5c",
  pad: "#b28dff",
  grandPiano: "#e8dcc8",
};
let leadColorHex = PATCH_COLORS[currentPatch];

// activeVoices maps an input id -> its {release} closure, so keyboard keys
// (id = e.code) and piano/canvas pointers (id = `pointer-...`) are tracked
// independently and can all sustain polyphonically at once.
const activeVoices = new Map();

function startVoice(id, freq, x, y) {
  if (activeVoices.has(id)) return; // already sounding - ignore OS key-repeat, double pointerdown, etc.
  activeVoices.set(id, PATCH_BUILDERS[currentPatch](freq, ctx.currentTime));
  if (x !== undefined) spawnRipple(x, y);
  if (pianoLoopPedal.state === "recording") pianoLoopPedal.noteOn(id, freq);
}

function releaseVoice(id) {
  const voice = activeVoices.get(id);
  if (!voice) return;
  voice.release();
  activeVoices.delete(id);
  if (pianoLoopPedal.state === "recording") pianoLoopPedal.noteOff(id);
}

// One-shot trigger: builds a voice with its attack scheduled at an exact
// future time, then schedules release() to fire roughly `holdDuration`
// later. This lets every patch - even slow-attack ones like Pad - sound
// coherent as a short, percussive "hit". Takes an explicit builder so the
// Backing Style engine (see §8) can trigger a fixed instrument (e.g. always
// Upright Bass for its bassline) independent of whatever lead Patch the
// user currently has selected.
function triggerVoice(builder, freq, time, holdDuration = 0.18) {
  const voice = builder(freq, time);
  const delayMs = Math.max(0, (time + holdDuration - ctx.currentTime) * 1000);
  setTimeout(() => voice.release(), delayMs);
}

// Constellation stars/canvas-preview always use whichever Patch is
// currently selected.
function triggerOneShot(freq, time, holdDuration = 0.18) {
  triggerVoice(PATCH_BUILDERS[currentPatch], freq, time, holdDuration);
}

// ============================================================
// 3. AUDIO ENGINE (built lazily on first gesture)
// ============================================================

let ctx = null;
let masterGain, compressor, dryGain, preMaster;
let delayNode, delayFeedback, delayWetGain;
let convolver, reverbWetGain;
let drumBus, noiseBuffer;
let currentBpm = 120;
let masterRecordDest;

function ensureEngine() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();

  compressor = ctx.createDynamicsCompressor();
  masterGain = ctx.createGain();
  masterGain.gain.value = 0.9;
  compressor.connect(masterGain);
  masterGain.connect(ctx.destination);

  // A tap for the global Record button: everything that reaches the
  // speakers also reaches this MediaStream, so recording it captures the
  // whole live mix (drums, loops, piano) rather than any single source.
  masterRecordDest = ctx.createMediaStreamDestination();
  masterGain.connect(masterRecordDest);

  // preMaster is where EVERY sound source - every drum hit, every
  // Constellation star, every live piano note - sums together before the
  // effects sends. Reverb and Delay are both fed from this single point,
  // so both are genuinely applied to the whole mix rather than per-voice.
  preMaster = ctx.createGain();
  preMaster.gain.value = 1;

  dryGain = ctx.createGain();
  dryGain.gain.value = 0.85;
  preMaster.connect(dryGain);
  dryGain.connect(compressor);

  // Reverb send: ConvolverNode fed a synthetic (algorithmically generated)
  // impulse response - no external sample needed.
  convolver = ctx.createConvolver();
  convolver.buffer = createImpulseResponse(2.5, 3);
  reverbWetGain = ctx.createGain();
  reverbWetGain.gain.value = 0; // driven by the Reverb slider
  preMaster.connect(convolver);
  convolver.connect(reverbWetGain);
  reverbWetGain.connect(compressor);

  // Delay send: a single DelayNode with feedback, tempo-synced so its
  // repeat time always lands exactly one sequencer step later (see
  // updateTempo()). The Delay slider only controls delayWetGain.
  delayNode = ctx.createDelay(1.0);
  delayFeedback = ctx.createGain();
  delayFeedback.gain.value = 0.3;
  delayNode.connect(delayFeedback);
  delayFeedback.connect(delayNode);
  delayWetGain = ctx.createGain();
  delayWetGain.gain.value = 0; // driven by the Delay slider
  preMaster.connect(delayNode);
  delayNode.connect(delayWetGain);
  delayWetGain.connect(compressor);

  // Drum bus - every drum voice mixes here, trimmed, then joins preMaster
  // alongside the Constellation stars and the live piano.
  drumBus = ctx.createGain();
  drumBus.gain.value = 0.8;
  drumBus.connect(preMaster);

  noiseBuffer = createNoiseBuffer();

  updateEffectSends();
  updateTempo();
  startScheduler();

  // Every Backing Style's real recording can't be decoded/analyzed before
  // ctx exists, so kick that off now rather than at page load.
  STYLE_SOURCES.forEach(decodeStyleSource);

  // A freshly created AudioContext always starts in the "running" state
  // (it's only ever created from a user gesture), so the global transport
  // reflects that immediately rather than waiting for its own button.
  setGlobalPlaying(true);
}

function createImpulseResponse(duration, decay) {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * duration);
  const impulse = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}

function createNoiseBuffer() {
  const length = ctx.sampleRate * 1.0;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

// Reverb/Delay sliders drive these gain nodes directly - no other logic.
function updateEffectSends() {
  if (!ctx) return;
  reverbWetGain.gain.setTargetAtTime(Number(reverbSlider.value) / 100 * 0.6, ctx.currentTime, 0.05);
  delayWetGain.gain.setTargetAtTime(Number(delaySlider.value) / 100 * 0.5, ctx.currentTime, 0.05);
}

// BPM sets the delay's tempo-synced repeat time (one sequencer step) and is
// read live by secondsPerStep()/tempoScaledDecay() used throughout the
// scheduler and drum envelopes below.
function updateTempo() {
  currentBpm = Number(bpmSlider.value);
  if (!ctx) return;
  delayNode.delayTime.setTargetAtTime(secondsPerStep(), ctx.currentTime, 0.05);
  // Real-recording 'style' clips are resampled (not pitch-preserving-
  // stretched) to the BPM slider via playbackRate, so every track currently
  // playing one has to be retuned live whenever the slider moves.
  tracks.forEach((track) => {
    if (!track.audioSource) return;
    const clip = findClip(track.clipId);
    if (!clip || clip.kind !== "style" || !clip.nativeBpm) return;
    track.audioSource.src.playbackRate.setTargetAtTime(currentBpm / clip.nativeBpm, ctx.currentTime, 0.05);
  });
}

function secondsPerStep() {
  return 60.0 / currentBpm / 2; // each grid column = one eighth note
}

function tempoScaledDecay(base, min, max) {
  return Math.max(min, Math.min(max, base * (120 / currentBpm)));
}

// ============================================================
// 4. DRUM SYNTHS (the looping backing track)
// ============================================================
// Every voice takes an explicit `time` (an audioContext.currentTime-based
// timestamp, usually slightly in the future) instead of reading "now" -
// this is what lets the scheduler below place hits with sample accuracy
// even though the JS call happens up to ~100ms before the sound is due.

function playHiHat(time) {
  const decay = tempoScaledDecay(0.06, 0.03, 0.1);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 8000;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, time);
  env.gain.linearRampToValueAtTime(0.4, time + 0.001);
  env.gain.exponentialRampToValueAtTime(0.0001, time + decay);
  src.connect(hp);
  hp.connect(env);
  env.connect(drumBus);
  const offset = Math.random() * (noiseBuffer.duration - 0.3);
  src.start(time, offset);
  src.stop(time + decay + 0.03);
  src.onended = () => { src.disconnect(); hp.disconnect(); env.disconnect(); };
}

function playSnare(time) {
  const decay = tempoScaledDecay(0.18, 0.08, 0.3);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1800;
  bp.Q.value = 1;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, time);
  env.gain.linearRampToValueAtTime(0.7, time + 0.002);
  env.gain.exponentialRampToValueAtTime(0.0001, time + decay);
  src.connect(bp);
  bp.connect(env);
  env.connect(drumBus);
  const offset = Math.random() * (noiseBuffer.duration - 0.3);
  src.start(time, offset);
  src.stop(time + decay + 0.05);
  src.onended = () => { src.disconnect(); bp.disconnect(); env.disconnect(); };
}

function playKick(time) {
  const decay = tempoScaledDecay(0.35, 0.18, 0.5);
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(150, time);
  osc.frequency.exponentialRampToValueAtTime(40, time + 0.12);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.9, time);
  env.gain.exponentialRampToValueAtTime(0.0001, time + decay);
  osc.connect(env);
  env.connect(drumBus);
  osc.start(time);
  osc.stop(time + decay + 0.05);
  osc.onended = () => { osc.disconnect(); env.disconnect(); };
}

// Low synth Tom - same pitch-drop recipe as the kick but starting and
// ending higher, with a shorter drop, so it reads as a pitched tom rather
// than a sub-bass kick even though both are just a swept sine.
function playTom(time) {
  const decay = tempoScaledDecay(0.28, 0.15, 0.45);
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(220, time);
  osc.frequency.exponentialRampToValueAtTime(90, time + 0.1);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.8, time);
  env.gain.exponentialRampToValueAtTime(0.0001, time + decay);
  osc.connect(env);
  env.connect(drumBus);
  osc.start(time);
  osc.stop(time + decay + 0.05);
  osc.onended = () => { osc.disconnect(); env.disconnect(); };
}

// Open Hat - the same noise-through-highpass recipe as playHiHat, but a
// longer decay and a gentler (lower-Q) filter so it rings out into a sizzle
// instead of snapping shut - the standard closed/open hi-hat distinction.
function playOpenHat(time) {
  const decay = tempoScaledDecay(0.4, 0.2, 0.6);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 7000;
  hp.Q.value = 0.3;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, time);
  env.gain.linearRampToValueAtTime(0.35, time + 0.001);
  env.gain.exponentialRampToValueAtTime(0.0001, time + decay);
  src.connect(hp);
  hp.connect(env);
  env.connect(drumBus);
  const offset = Math.random() * (noiseBuffer.duration - 0.6);
  src.start(time, offset);
  src.stop(time + decay + 0.05);
  src.onended = () => { src.disconnect(); hp.disconnect(); env.disconnect(); };
}

// Clap - three quick, tightly-spaced noise bursts through a bandpass, each
// slightly quieter than the last. A real hand clap is several near-
// simultaneous transients rather than one - this "flam" of 3 hits ~15ms
// apart is what reads as a clap rather than a snare.
function playClap(time) {
  const decay = tempoScaledDecay(0.22, 0.12, 0.32);
  const burstGains = [0.5, 0.4, 0.3];
  burstGains.forEach((peak, i) => {
    const burstTime = time + i * 0.015;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1600;
    bp.Q.value = 2;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, burstTime);
    env.gain.linearRampToValueAtTime(peak, burstTime + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, burstTime + decay);
    src.connect(bp);
    bp.connect(env);
    env.connect(drumBus);
    const offset = Math.random() * (noiseBuffer.duration - 0.3);
    src.start(burstTime, offset);
    src.stop(burstTime + decay + 0.05);
    src.onended = () => { src.disconnect(); bp.disconnect(); env.disconnect(); };
  });
}

// Rimshot - a very short blend of a bandpassed noise tick (the "rim" click)
// and a brief high triangle blip (the shell's pitched component), both gone
// within ~50ms - the sharp, dry crack of a stick striking the rim rather
// than the head.
function playRimshot(time) {
  const decay = tempoScaledDecay(0.05, 0.03, 0.08);

  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 3000;
  bp.Q.value = 3;
  const noiseEnv = ctx.createGain();
  noiseEnv.gain.setValueAtTime(0.5, time);
  noiseEnv.gain.exponentialRampToValueAtTime(0.0001, time + decay);
  src.connect(bp);
  bp.connect(noiseEnv);
  noiseEnv.connect(drumBus);
  const offset = Math.random() * (noiseBuffer.duration - 0.2);
  src.start(time, offset);
  src.stop(time + decay + 0.03);
  src.onended = () => { src.disconnect(); bp.disconnect(); noiseEnv.disconnect(); };

  const blip = ctx.createOscillator();
  blip.type = "triangle";
  blip.frequency.value = 900;
  const blipEnv = ctx.createGain();
  blipEnv.gain.setValueAtTime(0.4, time);
  blipEnv.gain.exponentialRampToValueAtTime(0.0001, time + decay);
  blip.connect(blipEnv);
  blipEnv.connect(drumBus);
  blip.start(time);
  blip.stop(time + decay + 0.03);
  blip.onended = () => { blip.disconnect(); blipEnv.disconnect(); };
}

// Cowbell - the classic 808 technique: two square oscillators at a fixed
// non-harmonic ratio (~1.48, close to a tritone-and-a-bit) through a
// resonant bandpass. The clashing overtones of two non-integer-related
// square waves is exactly what reads as "metallic clang" rather than a
// tuned pitch.
function playCowbell(time) {
  const decay = tempoScaledDecay(0.3, 0.18, 0.45);

  const osc1 = ctx.createOscillator();
  osc1.type = "square";
  osc1.frequency.value = 587;
  const osc2 = ctx.createOscillator();
  osc2.type = "square";
  osc2.frequency.value = 845;

  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 800;
  bp.Q.value = 1.5;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.35, time);
  env.gain.exponentialRampToValueAtTime(0.0001, time + decay);

  osc1.connect(bp);
  osc2.connect(bp);
  bp.connect(env);
  env.connect(drumBus);
  osc1.start(time);
  osc2.start(time);
  osc1.stop(time + decay + 0.05);
  osc2.stop(time + decay + 0.05);
  osc1.onended = () => { osc1.disconnect(); osc2.disconnect(); bp.disconnect(); env.disconnect(); };
}

// Row order top->bottom, matching the visual grid: Hat, Snare, Kick, Tom,
// Open Hat, Clap, Rimshot, Cowbell.
const DRUM_FUNCS = [playHiHat, playSnare, playKick, playTom, playOpenHat, playClap, playRimshot, playCowbell];

// ============================================================
// 5. LOOP PEDALS (piano + drum Kit) - capture only
// ============================================================
// A GarageBand/Boss-looper-style record -> stop cycle, generic enough to
// capture takes from both the live piano and the live drum Kit. Recording
// just timestamps events relative to when recording started; pressing
// Record a second time closes the take, rounds its elapsed length to the
// nearest whole bar (so it always tiles cleanly against the master clock
// even if the button presses weren't bar-aligned), and hands the finished
// { pattern, lengthBars } back to the caller instead of looping it forever
// itself - the Rec button handlers (see §9) wrap that into a Loop Library
// clip and launch it on a track, which is what actually plays it back.
function createLoopPedal() {
  let state = "idle"; // 'idle' -> 'recording' -> 'idle'
  let recording = null; // { startTime, events: [], pending: Map(voiceId -> event) }

  function pressRecord() {
    if (state === "idle") {
      recording = { startTime: ctx.currentTime, events: [], pending: new Map() };
      state = "recording";
      return { state };
    }
    const barDuration = STEP_COUNT * secondsPerStep();
    const lengthBars = Math.max(1, Math.round((ctx.currentTime - recording.startTime) / barDuration));
    const pattern = recording.events;
    recording = null;
    state = "idle";
    return { state, pattern, lengthBars };
  }

  // For sustained notes (the piano): call noteOn when a key goes down and
  // noteOff (with the same voiceId) when it comes back up, so the captured
  // pattern replays with the same held duration as the live performance.
  function noteOn(voiceId, payload) {
    if (state !== "recording") return;
    const ev = { offsetSec: ctx.currentTime - recording.startTime, payload, duration: 0.3 };
    recording.events.push(ev);
    recording.pending.set(voiceId, ev);
  }

  function noteOff(voiceId) {
    if (state !== "recording") return;
    const ev = recording.pending.get(voiceId);
    if (!ev) return;
    ev.duration = Math.max(0.05, ctx.currentTime - recording.startTime - ev.offsetSec);
    recording.pending.delete(voiceId);
  }

  // For one-shot hits (the drum Kit): no note-off needed.
  function hit(payload) {
    if (state !== "recording") return;
    recording.events.push({ offsetSec: ctx.currentTime - recording.startTime, payload, duration: null });
  }

  // Cancels an in-progress recording without producing a clip.
  function clear() {
    recording = null;
    state = "idle";
  }

  return {
    get state() { return state; },
    pressRecord,
    noteOn,
    noteOff,
    hit,
    clear,
  };
}

const pianoLoopPedal = createLoopPedal();
const drumLoopPedal = createLoopPedal();

// How a captured piano/drum pattern's events are replayed once it's loaded
// onto a track (see scheduleTracksBar in §7) - kept here, next to the
// pedals whose recordings they replay.
const LOOP_TRIGGERS = {
  piano: (freq, time, duration) => triggerOneShot(freq, time, duration || 0.3),
  drum: (row, time) => {
    DRUM_FUNCS[row](time);
    scheduleVisualFlash(time, () => flashKitPad(row));
  },
};

// ============================================================
// 6/7. LOOP LIBRARY + TRACKS (Loopy HD-style independent loopers)
// ============================================================
// Every recorded take (piano, drum Kit, voice) and every Backing Style is
// a `loopLibrary` clip - inert data that never plays by itself. `tracks`
// is a fixed set of independent loopers (like Loopy HD's launch rows or
// an Ableton session-view track): dragging a clip onto a track LOADS it
// there, and from that moment the track replays that clip forever, once
// every `clip.lengthBars` bars, completely independently of every other
// track's length and phase - there is no shared song timeline. That's
// what lets a 2-bar drum loop, a 4-bar Style, and an 8-bar piano take all
// run at once, and lets the user "arrange" a performance simply by
// swapping what's loaded on each track while playing.
//
// Backing Styles are no longer synthesized: each is a real licensed
// recording (see samples/CREDITS.md), decoded once and offered as two
// clips. The 'style' clip is a long excerpt, automatically analyzed for its
// native tempo and a clean loop point (see analyzeAndTrimLoop below), then
// played back through a `playbackRate` of currentBpm/nativeBpm - genuine
// speed+pitch resampling, exactly like changing the speed on a turntable.
// Since that ratio is recomputed from the live BPM slider on every play and
// re-tuned live by updateTempo() whenever the slider moves (see below), the
// resulting audible tempo always tracks the slider (accuracy of the
// detected nativeBpm only affects pitch/pace relative to the *original*
// recording, not whether it follows the slider). The 'sample' clip is the
// same recording untouched, looping at its own native speed as a "hear it
// as-is" alternative to the resampled excerpt.

let nextLoopId = 1;
let nextTrackId = 1;
let drumClipCount = 0;
let pianoClipCount = 0;
let voiceClipCount = 0;
// Tracks the most recently finished take from each loop pedal, so the
// pedal's own Play button (see §9) has something to toggle without the
// user having to scroll down to the Loop Library shelf.
let lastDrumClipId = null;
let lastPianoClipId = null;

const CLIP_COLORS = { piano: "var(--cyan)", drum: "var(--coral)", style: "var(--violet)", sample: "var(--gold)", voice: "var(--lime)" };

// How many beats analyzeAndTrimLoop cuts into the resampled 'style' loop -
// long enough to cover several musical phrases so the loop repeats far less
// obviously than a single-bar excerpt would.
const LOOP_BEATS = 32;

// { id, kind: 'piano'|'drum'|'style'|'sample'|'voice', name, color,
//   lengthBars (null for 'style'/'sample', which loop by their own buffer's
//   duration, not a bar count),
//   pattern? (piano/drum), audioBuffer? (voice/sample),
//   url/audioBuffer/loopBuffer/nativeBpm/status? (style) }
const loopLibrary = [];

// Each Backing Style is decoded from one real licensed recording (see
// samples/CREDITS.md) and surfaces as TWO Loop Library clips sharing that
// same decode: a 'style' clip - a short excerpt auto-trimmed to a beat
// boundary (see analyzeAndTrimLoop) and resampled live to the BPM slider via
// playbackRate - and a 'sample' clip, the untouched full recording looping
// at its own native speed, offered as an alternative for when the raw
// recording (not a resampled/trimmed excerpt of it) is what's wanted.
// `audioBuffer`/`loopBuffer`/`nativeBpm` all start null and are filled in
// once by decodeStyleSource, called from ensureEngine() the first time an
// AudioContext exists. `status` drives each card's length/BPM label:
// "pending" -> "Loading...", "ready" -> the detected BPM or full duration,
// "error" -> "Unavailable".
const STYLE_SOURCES = [
  { id: "bigBand", name: "Big Band", url: "./samples/big-band-main-stem.ogg" },
  { id: "swing", name: "Swing", url: "./samples/swing-walk-that-dog.ogg" },
  { id: "samba", name: "Samba", url: "./samples/samba-batucada.ogg" },
  { id: "bossaNova", name: "Bossa Nova", url: "./samples/bossa-nova-background-music.ogg" },
  { id: "elevator", name: "Elevator Music", url: "./samples/elevator-local-forecast.mp3" },
  { id: "latin", name: "Latin Cha-Cha", url: "./samples/latin-no-frills-salsa.mp3" },
  { id: "reggae", name: "Reggae", url: "./samples/reggae-tea-roots.oga" },
];
STYLE_SOURCES.forEach((source) => {
  source.styleClip = {
    id: nextLoopId++,
    kind: "style",
    name: source.name,
    color: CLIP_COLORS.style,
    lengthBars: null,
    audioBuffer: null,
    loopBuffer: null,
    nativeBpm: null,
    status: "pending",
  };
  source.liveClip = {
    id: nextLoopId++,
    kind: "sample",
    name: `${source.name} (Live)`,
    color: CLIP_COLORS.sample,
    lengthBars: null,
    audioBuffer: null,
    status: "pending",
  };
  loopLibrary.push(source.styleClip, source.liveClip);
});

// { id, name, clipId, pendingClipId, startBar, muted, audioSource, audioStartTime }
const tracks = [];
const MAX_TRACKS = 8;

function addTrack() {
  if (tracks.length >= MAX_TRACKS) return null;
  const track = {
    id: nextTrackId++, name: `Track ${tracks.length + 1}`, clipId: null, pendingClipId: null, startBar: null, muted: false,
    audioSource: null, // { src, gain } - only set while a 'style' or 'sample' clip is live on this track
    audioStartTime: null,
  };
  tracks.push(track);
  return track;
}
for (let i = 0; i < 4; i++) addTrack(); // 4 default lanes

function findClip(clipId) { return loopLibrary.find((c) => c.id === clipId); }
function findTrack(trackId) { return tracks.find((t) => t.id === trackId); }
function firstEmptyTrack() { return tracks.find((t) => t.clipId === null && t.pendingClipId === null); }

// Loading is quantized to the next bar line (see scheduleTracksBar's
// `pendingClipId` handling below) - a newly-dropped loop always enters in
// time, the same reasoning the old loop pedals used to snap to the bar.
function loadClipOntoTrack(trackId, clipId) {
  const track = findTrack(trackId);
  if (!track) return;
  track.pendingClipId = clipId;
  refreshTrackDeckUI();
}

// Stopping is immediate, not quantized - silence never clicks the way a
// mistimed note-on would, so there's no reason to make the user wait.
function clearTrack(trackId) {
  const track = findTrack(trackId);
  if (!track) return;
  stopTrackAudio(track);
  track.clipId = null;
  track.pendingClipId = null;
  track.startBar = null;
  refreshTrackDeckUI();
}

function toggleTrackMute(trackId) {
  const track = findTrack(trackId);
  if (!track) return;
  track.muted = !track.muted;
  // Every other kind is re-triggered (or not) per bar in scheduleTracksBar,
  // so muting them is just "stop scheduling new notes." A 'style'/'sample'
  // clip is one continuously-playing source with no per-bar re-trigger to
  // skip, so its own gain has to be ramped directly instead.
  if (track.audioSource) {
    const g = track.audioSource.gain.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setTargetAtTime(track.muted ? 0 : 1, ctx.currentTime, 0.01);
  }
  refreshTrackDeckUI();
}

// One AudioBufferSourceNode per cycle, connected to the same preMaster bus
// every other voice uses, so a voice take gets the same Reverb/Delay sends
// with zero extra plumbing.
function playVoiceClip(clip, time) {
  const src = ctx.createBufferSource();
  src.buffer = clip.audioBuffer;
  src.connect(preMaster);
  src.start(time);
}

// A 'style' clip's `loopBuffer` is a short excerpt trimmed to an exact
// number of beats at its own detected `nativeBpm` (see analyzeAndTrimLoop) -
// it can't be re-triggered bar-by-bar like a synthesized clip, so it plays
// as a single self-looping AudioBufferSourceNode through a dedicated
// GainNode (so toggleTrackMute can ramp it independently of every other
// track), with `playbackRate` continuously resampling it to the live BPM
// slider (see updateTempo). Still connects to preMaster, so Reverb/Delay
// apply the same way.
function playStyleClipOnTrack(track, clip, time) {
  const src = ctx.createBufferSource();
  src.buffer = clip.loopBuffer;
  src.loop = true;
  src.playbackRate.value = currentBpm / clip.nativeBpm;
  const gain = ctx.createGain();
  gain.gain.value = track.muted ? 0 : 1;
  src.connect(gain);
  gain.connect(preMaster);
  src.start(time);
  track.audioSource = { src, gain };
  track.audioStartTime = time;
}

// A 'sample' clip is the untouched full recording behind a 'style' clip,
// offered as an alternative to the resampled excerpt - it loops at its own
// native speed (playbackRate stays at 1) and is deliberately NOT retuned by
// updateTempo, since the point of choosing it is to hear the real recording
// as-is rather than a BPM-matched resample of it.
function playSampleClipOnTrack(track, clip, time) {
  const src = ctx.createBufferSource();
  src.buffer = clip.audioBuffer;
  src.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = track.muted ? 0 : 1;
  src.connect(gain);
  gain.connect(preMaster);
  src.start(time);
  track.audioSource = { src, gain };
  track.audioStartTime = time;
}

function stopTrackAudio(track) {
  if (!track.audioSource) return;
  const { src, gain } = track.audioSource;
  try { src.stop(); } catch { /* already stopped */ }
  src.disconnect();
  gain.disconnect();
  track.audioSource = null;
  track.audioStartTime = null;
}

// Downmixes an AudioBuffer to a single mono Float32Array, averaging all
// channels - every analysis step below only needs overall energy/timing,
// not stereo detail.
function downmixToMono(audioBuffer) {
  const length = audioBuffer.length;
  const mono = new Float32Array(length);
  const channels = audioBuffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += data[i] / channels;
  }
  return mono;
}

// Automatic tempo + loop-point detection, no external libraries - this is
// necessarily best-effort (real recordings have intros, rubato, fills) and
// can't be verified by ear on the agent's end; if a card's detected BPM or
// loop point sounds wrong, that's expected, and worth reporting so the
// analysis parameters below (the BPM prior center, the safe-zone fractions)
// can be retuned.
function analyzeAndTrimLoop(audioBuffer) {
  const sr = audioBuffer.sampleRate;
  const mono = downmixToMono(audioBuffer);

  // 1. Short-time RMS energy envelope, 512-sample hop.
  const hop = 512;
  const frameCount = Math.floor(mono.length / hop);
  const energy = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = 0; i < hop; i++) { const s = mono[start + i]; sum += s * s; }
    energy[f] = Math.sqrt(sum / hop);
  }

  // 2. Positive-flux onset detection function - only frame-to-frame energy
  // increases count as "onsets," since decays carry no timing information.
  const onset = new Float32Array(frameCount);
  for (let f = 1; f < frameCount; f++) onset[f] = Math.max(0, energy[f] - energy[f - 1]);

  // 3. Autocorrelate the onset function over the 60-200 BPM lag range,
  // weighting scores with a Gaussian prior centered on 112 BPM to bias away
  // from octave errors (e.g. reading a busy samba as double-time).
  const framesPerSec = sr / hop;
  const minLag = Math.round(framesPerSec * 60 / 200);
  const maxLag = Math.round(framesPerSec * 60 / 60);
  let bestLag = minLag;
  let bestScore = -Infinity;
  const priorBpm = 112;
  const priorWidth = 40;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let f = 0; f + lag < frameCount; f++) corr += onset[f] * onset[f + lag];
    const bpmAtLag = (framesPerSec * 60) / lag;
    const prior = Math.exp(-((bpmAtLag - priorBpm) ** 2) / (2 * priorWidth * priorWidth));
    const score = corr * prior;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }

  // 4. Fold the winning lag into a musically plausible 70-180 BPM range.
  let bpm = (framesPerSec * 60) / bestLag;
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;

  // 5. Pick a loop start: search a safe zone (skip the first ~12% and last
  // ~15%, avoiding intros/outros/fades) for the onset-function peak closest
  // to a detected beat boundary - a best-effort downbeat proxy.
  const safeStart = Math.floor(frameCount * 0.12);
  const safeEnd = Math.floor(frameCount * 0.85);
  let peakFrame = safeStart;
  let peakVal = -Infinity;
  for (let f = safeStart; f < safeEnd; f++) {
    if (onset[f] > peakVal) { peakVal = onset[f]; peakFrame = f; }
  }
  const loopStartSec = (peakFrame * hop) / sr;

  // 6. Trim a 32-beat (8-bar) window from loopStartSec into a new, smaller
  // buffer, with a short linear fade-in/out to hide the loop seam. 32 beats
  // covers several musical phrases rather than a single lick, so the loop
  // repeats far less obviously than a 4-beat excerpt would.
  const beatDurationSec = 60 / bpm;
  const loopDurationSec = Math.min(LOOP_BEATS * beatDurationSec, audioBuffer.duration - loopStartSec);
  const startSample = Math.floor(loopStartSec * sr);
  const frameLength = Math.max(1, Math.floor(loopDurationSec * sr));
  const loopBuffer = ctx.createBuffer(audioBuffer.numberOfChannels, frameLength, sr);
  const fadeSamples = Math.min(Math.floor(sr * 0.015), Math.floor(frameLength / 4));
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const src = audioBuffer.getChannelData(c);
    const dst = loopBuffer.getChannelData(c);
    for (let i = 0; i < frameLength; i++) {
      let sample = src[startSample + i] || 0;
      if (i < fadeSamples) sample *= i / fadeSamples;
      else if (i >= frameLength - fadeSamples) sample *= (frameLength - i) / fadeSamples;
      dst[i] = sample;
    }
  }

  return { loopBuffer, nativeBpm: bpm };
}

function formatClipDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// Fetches and decodes a Backing Style source ONCE, then feeds that single
// decode into both of its Loop Library clips: the 'style' clip (trimmed +
// analyzed via analyzeAndTrimLoop) and the 'sample' clip (the full decode,
// untouched). Can't run before ctx exists, so it's called from
// ensureEngine() rather than at page load; updates each clip's
// already-rendered Loop Library card in place once ready.
function decodeStyleSource(source) {
  const { styleClip, liveClip } = source;
  const lenEl = (clip) => clip.cardEl?.querySelector(".loop-card-len");
  fetch(source.url)
    .then((res) => res.arrayBuffer())
    .then((buf) => ctx.decodeAudioData(buf))
    .then((audioBuffer) => {
      liveClip.audioBuffer = audioBuffer;
      liveClip.status = "ready";
      if (lenEl(liveClip)) lenEl(liveClip).textContent = formatClipDuration(audioBuffer.duration);

      styleClip.audioBuffer = audioBuffer;
      const { loopBuffer, nativeBpm } = analyzeAndTrimLoop(audioBuffer);
      styleClip.loopBuffer = loopBuffer;
      styleClip.nativeBpm = nativeBpm;
      styleClip.status = "ready";
      if (lenEl(styleClip)) lenEl(styleClip).textContent = `${Math.round(nativeBpm)} BPM`;
    })
    .catch(() => {
      liveClip.status = "error";
      styleClip.status = "error";
      if (lenEl(liveClip)) lenEl(liveClip).textContent = "Unavailable";
      if (lenEl(styleClip)) lenEl(styleClip).textContent = "Unavailable";
    });
}

// Called once per bar (see scheduleStep()'s step===0 branch below) - the
// direct replacement for the old pianoLoopPedal.schedule/
// drumLoopPedal.schedule/scheduleStyleBar calls, now covering an arbitrary
// number of independent tracks instead of two fixed pedals and one global
// style toggle.
function scheduleTracksBar(barIdx, time) {
  tracks.forEach((track) => {
    if (track.pendingClipId !== null) {
      const pendingClip = findClip(track.pendingClipId);
      // A 'style'/'sample' clip can't be launched before its audio has
      // finished decoding (and, for 'style', analyzing) - if it's not ready
      // yet, leave pendingClipId set and try again next bar rather than
      // promoting to a clip with no buffer to play.
      const ready = !pendingClip
        || (pendingClip.kind !== "style" && pendingClip.kind !== "sample")
        || (pendingClip.kind === "style" ? pendingClip.loopBuffer : pendingClip.audioBuffer);
      if (ready) {
        stopTrackAudio(track);
        track.clipId = track.pendingClipId;
        track.pendingClipId = null;
        track.startBar = barIdx;
        if (pendingClip?.kind === "style") playStyleClipOnTrack(track, pendingClip, time);
        else if (pendingClip?.kind === "sample") playSampleClipOnTrack(track, pendingClip, time);
      }
    }
    if (track.clipId === null || track.muted) return;
    const clip = findClip(track.clipId);
    if (!clip || clip.kind === "style" || clip.kind === "sample") return; // already playing continuously - nothing to (re)schedule per bar
    const localBar = (barIdx - track.startBar) % clip.lengthBars;
    if (localBar === 0 && (clip.kind === "piano" || clip.kind === "drum")) {
      clip.pattern.forEach((ev) => LOOP_TRIGGERS[clip.kind](ev.payload, time + ev.offsetSec, ev.duration));
    } else if (clip.kind === "voice" && localBar === 0) {
      playVoiceClip(clip, time);
    }
  });
}

// ============================================================
// 8. THE MASTER CLOCK / LOOKAHEAD SCHEDULER
// ============================================================
// Standard Web-Audio scheduling pattern: a setTimeout tick (LOOKAHEAD_MS)
// repeatedly checks "is the next step due within SCHEDULE_AHEAD_TIME
// seconds of real audio time?" and if so, books it using precise
// audioContext.currentTime-based timestamps. The JS timer only decides
// WHEN to schedule; the Web Audio nodes themselves decide WHEN to sound,
// immune to any setTimeout/rAF jitter. This is what makes the loop tight
// even though the browser's JS clock is not - and the exact same
// scheduled timestamp is reused to place Constellation stars, so the
// canvas playhead and the drum grid never drift apart.
//
// GRID NOTE: the brief's "4x4 grid... 16-step loop" is read here as 4
// tracks x 4 eighth-note steps = one bar (16 total pads across the whole
// grid) - the interpretation consistent with the grid's literal 4x4 shape
// and with Swing, which conventionally swings eighth notes (applied below).

const STEP_COUNT = 4;              // 4 columns = 4 eighth notes = one bar
const LOOKAHEAD_MS = 25;           // how often the JS timer wakes up to check
const SCHEDULE_AHEAD_TIME = 0.1;   // how far ahead of "now" we're allowed to book audio events

let isPlaying = false;
let currentStep = 0;
let nextStepTime = 0;
let barStartTime = 0; // audioContext.currentTime of the most recently scheduled step 0 - drives the Constellation playhead
let barIndex = 0; // increments every bar - lets each track work out its own localBar within its loaded clip

let drumGrid = [
  [false, false, false, false], // hihat
  [false, false, false, false], // snare
  [false, false, false, false], // kick
  [false, false, false, false], // tom
  [false, false, false, false], // open hat
  [false, false, false, false], // clap
  [false, false, false, false], // rimshot
  [false, false, false, false], // cowbell
];

function startScheduler() {
  if (isPlaying) return;
  isPlaying = true;
  currentStep = 0;
  nextStepTime = ctx.currentTime + 0.05;
  schedulerTick();
}

function schedulerTick() {
  // Drain every step that falls inside the lookahead window. Usually this
  // runs once per tick, but if the tab was backgrounded and timers were
  // throttled, this while-loop catches the scheduler back up in one go
  // instead of dropping steps.
  while (nextStepTime < ctx.currentTime + SCHEDULE_AHEAD_TIME) {
    scheduleStep(currentStep, nextStepTime);
    advanceStep();
  }
  setTimeout(schedulerTick, LOOKAHEAD_MS);
}

function advanceStep() {
  const swingAmount = Number(swingSlider.value) / 100; // 0..1
  currentStep = (currentStep + 1) % STEP_COUNT;
  // Swing: delay the even-numbered steps (2nd and 4th, i.e. the eighth-note
  // "ands") by up to ~2/3 of a step, for a human/jazzy shuffle feel. This
  // slightly lengthens the bar as swing increases, which is inaudible.
  const isEvenNumbered = currentStep % 2 === 1; // zero-indexed steps 1,3 = musical steps 2,4
  const swingOffset = isEvenNumbered ? swingAmount * secondsPerStep() * 0.66 : 0;
  nextStepTime += secondsPerStep() + swingOffset;
}

function scheduleStep(step, time) {
  for (let row = 0; row < DRUM_FUNCS.length; row++) {
    if (drumGrid[row][step]) {
      DRUM_FUNCS[row](time);
      scheduleVisualFlash(time, () => flashPad(row, step));
    }
  }
  if (step === 0) {
    barIndex++;
    barStartTime = time;
    scheduleConstellationBar(time);
    scheduleTracksBar(barIndex, time);
  }
}

// Audio events are booked ahead of real time; this converts that same
// future audioContext timestamp into a real-world setTimeout delay so the
// on-screen effect lands in sync with the sound the user actually hears.
function scheduleVisualFlash(time, callback) {
  const msUntil = Math.max(0, (time - ctx.currentTime) * 1000);
  setTimeout(callback, msUntil);
}

function flashPad(row, step) {
  const pad = padElements[row][step];
  pad.classList.add("hit");
  setTimeout(() => pad.classList.remove("hit"), 100);
}

// Schedules every star's trigger for the bar that just started at `time`,
// using the SAME timestamp the drum steps for this bar are booked against -
// this is what keeps the canvas playhead and the drum grid perfectly synced.
function scheduleConstellationBar(time) {
  const barDuration = STEP_COUNT * secondsPerStep();
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return;
  stars.forEach((star) => {
    const triggerTime = time + (star.x / rect.width) * barDuration;
    const freq = quantizeCanvasY(star.y / rect.height); // recomputed live, so a scale change re-quantizes existing stars too
    triggerOneShot(freq, triggerTime);
    scheduleVisualFlash(triggerTime, () => { star.flashUntil = performance.now() + 220; });
  });
}

// ============================================================
// 9. DOM WIRING
// ============================================================

const dashboard = document.querySelector(".dashboard");
const drumSectionEl = document.getElementById("drum-section");
const drumPadsEl = document.getElementById("drum-pads");
const drumKitPadsEl = document.getElementById("drum-kit-pads");
const drumModeStepBtn = document.getElementById("drum-mode-step");
const drumModeKitBtn = document.getElementById("drum-mode-kit");
const drumLoopRecBtn = document.getElementById("drum-loop-rec");
const drumLoopPlayBtn = document.getElementById("drum-loop-play");
const drumLoopClearBtn = document.getElementById("drum-loop-clear");
const canvas = document.getElementById("constellation-canvas");
const cctx = canvas.getContext("2d");
const scaleSelect = document.getElementById("scale-select");
const patchSelect = document.getElementById("patch-select");
const reverbSlider = document.getElementById("reverb-slider");
const delaySlider = document.getElementById("delay-slider");
const bpmSlider = document.getElementById("bpm-slider");
const swingSlider = document.getElementById("swing-slider");
const octaveSlider = document.getElementById("octave-slider");
const pianoKeysEl = document.getElementById("piano-keys");
const pianoLoopRecBtn = document.getElementById("piano-loop-rec");
const pianoLoopPlayBtn = document.getElementById("piano-loop-play");
const pianoLoopClearBtn = document.getElementById("piano-loop-clear");
const loopShelfEl = document.getElementById("loop-shelf");
const trackListEl = document.getElementById("track-list");
const addTrackBtn = document.getElementById("add-track-btn");
const recordVoiceBtn = document.getElementById("record-voice-btn");
const voiceStatusEl = document.getElementById("voice-status");
const globalPlayBtn = document.getElementById("global-play-btn");
const globalRecordBtn = document.getElementById("global-record-btn");
const globalRecordStatusEl = document.getElementById("global-record-status");

function markStarted() {
  dashboard.classList.add("started");
}

// --- Drum grid: build 16 pads (4 rows x 4 steps), each a toggle switch ---

const ROW_LABELS = ["HAT", "SNR", "KCK", "TOM", "OHT", "CLP", "RIM", "CWB"];
const padElements = [];

// Shared by pointer AND physical-keyboard input (see DRUM_KEY_CODES below)
// so both trigger the exact same toggle + preview-hit behavior.
function toggleDrumPad(row, step) {
  drumGrid[row][step] = !drumGrid[row][step];
  padElements[row][step].classList.toggle("on", drumGrid[row][step]);
  if (drumGrid[row][step]) DRUM_FUNCS[row](ctx.currentTime); // immediate preview hit
}

// Dedicated keys for toggling the step-grid pads directly, row-major
// (matching the grid's own [row][step] layout) and deliberately disjoint
// from the piano's 30-key footprint (Z-/, A-;, Q-P). Only Digit1-8 are
// reserved here - QWERTYUIOP went to the piano's third row instead - so
// only 4 rows are reachable: unshifted reaches rows 0-1, Shift held reaches
// rows 2-3. Rows 4-7 (the newer voices) are click/tap-only.
const DRUM_KEY_CODES = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8"];
const DRUM_KEY_LABELS = ["1", "2", "3", "4", "5", "6", "7", "8"];

for (let row = 0; row < DRUM_FUNCS.length; row++) {
  padElements[row] = [];
  for (let step = 0; step < 4; step++) {
    const pad = document.createElement("div");
    pad.className = "pad";
    pad.dataset.row = row;
    pad.dataset.step = step;
    if (step === 0) {
      const label = document.createElement("span");
      label.className = "row-label";
      label.textContent = ROW_LABELS[row];
      pad.appendChild(label);
    }
    // Only rows 0-3 have a keyboard shortcut: rows 0-1 are reached
    // unshifted, rows 2-3 by holding Shift - shown here exactly as the
    // keydown listener below expects it. Rows 4-7 are click/tap-only, so
    // they get no key-label at all.
    if (row < 4) {
      const keyLabel = document.createElement("span");
      keyLabel.className = "key-label";
      const shifted = row >= 2;
      const rowInGroup = row % 2;
      keyLabel.textContent = (shifted ? "⇧" : "") + DRUM_KEY_LABELS[rowInGroup * 4 + step];
      pad.appendChild(keyLabel);
    }
    pad.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      markStarted();
      ensureEngine();
      toggleDrumPad(row, step);
    });
    padElements[row][step] = pad;
    drumPadsEl.appendChild(pad);
  }
}

// --- Drum Kit: 4 big live-playable pads, one per voice - GarageBand-style
//     alternative to the Step grid, sharing the same synth functions. ---

const kitPadElements = [];
for (let row = 0; row < DRUM_FUNCS.length; row++) {
  const pad = document.createElement("div");
  pad.className = "kit-pad";
  pad.dataset.row = row;
  const label = document.createElement("span");
  label.className = "row-label";
  label.textContent = ROW_LABELS[row];
  pad.appendChild(label);
  pad.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    markStarted();
    ensureEngine();
    DRUM_FUNCS[row](ctx.currentTime);
    flashKitPad(row);
    if (drumLoopPedal.state === "recording") drumLoopPedal.hit(row);
  });
  kitPadElements.push(pad);
  drumKitPadsEl.appendChild(pad);
}

function flashKitPad(row) {
  const pad = kitPadElements[row];
  pad.classList.add("hit");
  setTimeout(() => pad.classList.remove("hit"), 100);
}

// --- Step / Kit mode toggle - purely a view switch; both keep sounding
//     underneath regardless of which one is currently shown. ---

function setDrumMode(mode) {
  drumSectionEl.classList.toggle("mode-kit", mode === "kit");
  drumModeStepBtn.classList.toggle("active", mode === "step");
  drumModeKitBtn.classList.toggle("active", mode === "kit");
}
drumModeStepBtn.addEventListener("click", () => setDrumMode("step"));
drumModeKitBtn.addEventListener("click", () => setDrumMode("kit"));

// --- Drum loop pedal: records live Kit pad hits. Finishing a take turns
//     it into a Loop Library clip (see addRecordedClip below) instead of
//     looping it forever by itself. ---

function refreshLoopButton(btn, pedal) {
  btn.classList.toggle("recording", pedal.state === "recording");
  btn.innerHTML = pedal.state === "recording" ? "&#9632; Stop" : "&#9679; Rec";
}

// Shared by both the drum-Kit and piano loop pedals: wraps a finished
// { pattern, lengthBars } take into a Loop Library clip, adds its card to
// the shelf, and auto-launches it on the first empty track so pressing Rec
// still "just works" exactly like the old always-on pedals did.
function addRecordedClip(kind, result) {
  const name = kind === "drum" ? `Drum ${++drumClipCount}` : `Piano ${++pianoClipCount}`;
  const clip = { id: nextLoopId++, kind, name, color: CLIP_COLORS[kind], lengthBars: result.lengthBars, pattern: result.pattern };
  loopLibrary.push(clip);
  addLoopCard(clip);
  if (kind === "drum") lastDrumClipId = clip.id; else lastPianoClipId = clip.id;
  const target = firstEmptyTrack();
  if (target) loadClipOntoTrack(target.id, clip.id);
}

drumLoopRecBtn.addEventListener("click", () => {
  markStarted();
  ensureEngine();
  const result = drumLoopPedal.pressRecord();
  refreshLoopButton(drumLoopRecBtn, drumLoopPedal);
  if (result.pattern) addRecordedClip("drum", result);
});
drumLoopPlayBtn.addEventListener("click", () => {
  if (lastDrumClipId === null) return;
  toggleClipPlayback(lastDrumClipId);
});
drumLoopClearBtn.addEventListener("click", () => {
  drumLoopPedal.clear();
  refreshLoopButton(drumLoopRecBtn, drumLoopPedal);
});

let lastHighlightedCol = -1;
function updateColumnHighlight(col) {
  if (col === lastHighlightedCol) return;
  for (let row = 0; row < DRUM_FUNCS.length; row++) {
    if (lastHighlightedCol >= 0) padElements[row][lastHighlightedCol].classList.remove("playhead-col");
    padElements[row][col].classList.add("playhead-col");
  }
  lastHighlightedCol = col;
}

// --- Constellation canvas: click/touch drops or removes a looping star ---

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

let stars = []; // persistent looped notes: { x, y, flashUntil }
const STAR_HIT_RADIUS = 16; // clicking near an existing star removes it, so the loop never becomes an unremovable wall of noise

canvas.addEventListener("pointerdown", (e) => {
  markStarted();
  ensureEngine();
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const hitIndex = stars.findIndex((s) => Math.hypot(s.x - x, s.y - y) < STAR_HIT_RADIUS);
  if (hitIndex !== -1) {
    stars.splice(hitIndex, 1);
    return;
  }

  const star = { x, y, flashUntil: 0 };
  stars.push(star);
  // Immediate feedback so placing a star is audibly confirmed right away,
  // not just silently queued for the next time the playhead sweeps past it.
  const freq = quantizeCanvasY(y / rect.height);
  triggerOneShot(freq, ctx.currentTime);
  star.flashUntil = performance.now() + 220;
});

// --- Ripple visualizer for LIVE notes (piano / physical keyboard). Purely
//     cosmetic feedback, kept separate from the persistent star field. ---

let ripples = [];
const RIPPLE_LIFETIME_MS = 650;

function spawnRipple(x, y) {
  ripples.push({ x, y, start: performance.now() });
}

// Maps a piano key element's on-screen position into the canvas's local
// coordinate space, so live notes ripple out from roughly where they were
// played even though the piano overlay sits outside the canvas element.
function pianoKeyCanvasPos(keyEl) {
  const kRect = keyEl.getBoundingClientRect();
  const cRect = canvas.getBoundingClientRect();
  return { x: kRect.left + kRect.width / 2 - cRect.left, y: kRect.top - cRect.top };
}

// --- Combined draw loop: gridlines, sweeping playhead, stars, ripples ---

function draw(now) {
  requestAnimationFrame(draw);
  const rect = canvas.getBoundingClientRect();
  cctx.clearRect(0, 0, rect.width, rect.height);

  // Faint horizontal gridlines hinting at the canvas's scale-quantized
  // pitch rows, so the "Y-axis picks a pitch" mapping is visible without
  // any written text.
  cctx.strokeStyle = "rgba(125,139,171,0.12)";
  cctx.lineWidth = 1;
  for (let i = 0; i <= CANVAS_NOTE_TABLE.length; i++) {
    const y = rect.height * (1 - i / CANVAS_NOTE_TABLE.length);
    cctx.beginPath();
    cctx.moveTo(0, y);
    cctx.lineTo(rect.width, y);
    cctx.stroke();
  }

  // Sweeping playhead - continuous position derived from the same
  // barStartTime the scheduler stamps every bar, so it stays locked to the
  // drum grid without needing its own separate clock.
  if (ctx && isPlaying) {
    const barDuration = STEP_COUNT * secondsPerStep();
    let barProgress = ((ctx.currentTime - barStartTime) / barDuration) % 1;
    if (barProgress < 0) barProgress += 1;
    const x = barProgress * rect.width;
    cctx.strokeStyle = "rgba(220,228,255,0.5)";
    cctx.lineWidth = 2;
    cctx.beginPath();
    cctx.moveTo(x, 0);
    cctx.lineTo(x, rect.height);
    cctx.stroke();
  }

  // Stars: persistent glowing points, with a brighter pulse ring for
  // ~220ms right when the playhead triggers them.
  stars.forEach((star) => {
    const flashing = now < star.flashUntil;
    cctx.beginPath();
    cctx.fillStyle = flashing ? leadColorHex : "#dce4ff";
    cctx.shadowColor = leadColorHex;
    cctx.shadowBlur = flashing ? 22 : 8;
    cctx.arc(star.x, star.y, flashing ? 6 : 4, 0, Math.PI * 2);
    cctx.fill();
    if (flashing) {
      const age = 1 - (star.flashUntil - now) / 220;
      cctx.beginPath();
      cctx.strokeStyle = leadColorHex;
      cctx.globalAlpha = 1 - age;
      cctx.lineWidth = 2;
      cctx.arc(star.x, star.y, 6 + age * 26, 0, Math.PI * 2);
      cctx.stroke();
      cctx.globalAlpha = 1;
    }
  });

  // Ripples: transient rings for live (un-looped) notes.
  ripples = ripples.filter((r) => now - r.start < RIPPLE_LIFETIME_MS);
  ripples.forEach((r) => {
    const age = (now - r.start) / RIPPLE_LIFETIME_MS;
    const radius = 8 + age * 70;
    cctx.beginPath();
    cctx.strokeStyle = leadColorHex;
    cctx.globalAlpha = 1 - age;
    cctx.lineWidth = 3;
    cctx.shadowColor = leadColorHex;
    cctx.shadowBlur = 18 * (1 - age);
    cctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
    cctx.stroke();
  });
  cctx.globalAlpha = 1;
  cctx.shadowBlur = 0;

  if (ctx && isPlaying) {
    updateColumnHighlight((currentStep - 1 + STEP_COUNT) % STEP_COUNT);
  }
}
requestAnimationFrame(draw);

// --- Live Piano: on-screen keys, generated once, wired to pointer input ---
// Three stacked rows, mirroring the physical keyboard's own geometry:
// top = the Q-W-E-R-T-Y-U-I-O-P keys (highest register), middle = the
// A-S-D-F-G-H-J-K-L-; keys, bottom = the Z-X-C-V-B-N-M-,-.-/ keys (lowest
// register) - each row directly below the last on a real keyboard, and
// directly below it here.
const pianoRowTop = document.createElement("div");
pianoRowTop.className = "piano-key-row";
const pianoRowMiddle = document.createElement("div");
pianoRowMiddle.className = "piano-key-row";
const pianoRowBottom = document.createElement("div");
pianoRowBottom.className = "piano-key-row";
pianoKeysEl.appendChild(pianoRowTop);
pianoKeysEl.appendChild(pianoRowMiddle);
pianoKeysEl.appendChild(pianoRowBottom);

const pianoKeyElements = KB_KEYS.map((code, i) => {
  const key = document.createElement("div");
  key.className = "piano-key";
  key.dataset.index = i;
  key.textContent = KB_LABELS[i];

  const voiceId = `piano-${i}`;
  const press = (e) => {
    e.preventDefault();
    markStarted();
    ensureEngine();
    key.classList.add("active");
    const pos = pianoKeyCanvasPos(key);
    startVoice(voiceId, KB_FREQS[i], pos.x, pos.y);
  };
  const release = () => {
    key.classList.remove("active");
    releaseVoice(voiceId);
  };

  key.addEventListener("pointerdown", press);
  key.addEventListener("pointerup", release);
  key.addEventListener("pointercancel", release);
  key.addEventListener("pointerleave", release); // sliding off the key releases it, like a real key

  const targetRow = i < LEFT_HAND_KEYS.length ? pianoRowBottom
    : i < LEFT_HAND_KEYS.length + RIGHT_HAND_KEYS.length ? pianoRowMiddle
    : pianoRowTop;
  targetRow.appendChild(key);
  return key;
});

// --- Piano loop pedal: records live piano notes. Finishing a take turns
//     it into a Loop Library clip, same as the drum Kit pedal above. ---

pianoLoopRecBtn.addEventListener("click", () => {
  markStarted();
  ensureEngine();
  const result = pianoLoopPedal.pressRecord();
  refreshLoopButton(pianoLoopRecBtn, pianoLoopPedal);
  if (result.pattern) addRecordedClip("piano", result);
});
pianoLoopPlayBtn.addEventListener("click", () => {
  if (lastPianoClipId === null) return;
  toggleClipPlayback(lastPianoClipId);
});
pianoLoopClearBtn.addEventListener("click", () => {
  pianoLoopPedal.clear();
  refreshLoopButton(pianoLoopRecBtn, pianoLoopPedal);
});

// --- Scale/patch/octave controls ---

scaleSelect.addEventListener("change", () => {
  currentScale = scaleSelect.value;
  rebuildScaleTables();
});

octaveSlider.addEventListener("input", () => {
  octaveShift = Number(octaveSlider.value);
  rebuildScaleTables();
});

patchSelect.addEventListener("change", () => {
  currentPatch = patchSelect.value;
  leadColorHex = PATCH_COLORS[currentPatch];
  document.documentElement.style.setProperty("--lead-color", leadColorHex);
});

// ============================================================
// Loop Library shelf + Track Deck UI
// ============================================================
// Renders the draggable clip-card shelf and the track lanes, and wires up
// the touch-and-mouse-compatible drag-and-drop between them. Deliberately
// NOT native HTML5 drag-and-drop, which has no touch support - this app
// guarantees full mouse/keyboard/touch parity everywhere else, so drag
// here is built from plain pointer events instead.

const trackLaneEls = new Map(); // trackId -> lane element
const trackProgressEls = new Map(); // trackId -> progress-bar fill element
const clipCardEls = new Map(); // clipId -> loop-card element, for syncing the Play/Stop button

function addLoopCard(clip) {
  const card = document.createElement("div");
  card.className = `loop-card kind-${clip.kind}`;
  card.style.setProperty("--card-color", clip.color);
  // 'style'/'sample' clips have no bar length (they're real recordings,
  // decoded/analyzed lazily once ctx exists - see decodeStyleSource) so the
  // length label shows a loading/BPM/duration/error state instead of "N bars".
  const lenLabel = clip.kind === "style"
    ? (clip.status === "ready" ? `${Math.round(clip.nativeBpm)} BPM` : clip.status === "error" ? "Unavailable" : "Loading…")
    : clip.kind === "sample"
    ? (clip.status === "ready" ? formatClipDuration(clip.audioBuffer.duration) : clip.status === "error" ? "Unavailable" : "Loading…")
    : `${clip.lengthBars} bar${clip.lengthBars === 1 ? "" : "s"}`;
  // Backing Style presets (both the "style" and "(Live)" "sample" cards)
  // are always present and can't be deleted; only recorded takes
  // (drum/piano/voice) get a delete button.
  const deletable = clip.kind === "drum" || clip.kind === "piano" || clip.kind === "voice";
  card.innerHTML = `
    <div class="loop-card-top">
      <button type="button" class="loop-card-playbtn" title="Play/Stop">&#9654;</button>
      <span class="loop-card-name">${clip.name}</span>
      ${deletable ? `<button type="button" class="loop-card-delbtn" title="Delete recording">&#10005;</button>` : ""}
    </div>
    <span class="loop-card-len">${lenLabel}</span>
  `;
  const playBtn = card.querySelector(".loop-card-playbtn");
  playBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  playBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleClipPlayback(clip.id);
  });
  if (deletable) {
    const delBtn = card.querySelector(".loop-card-delbtn");
    delBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteClip(clip.id);
    });
  }
  loopShelfEl.appendChild(card);
  clip.cardEl = card;
  clipCardEls.set(clip.id, card);
  makeDraggable(card, clip.id);
}

// Removes a recorded take (drum/piano/voice) entirely: stops it if it's
// currently loaded on a track, drops it from the Loop Library, and clears
// it from a loop pedal's own Play button if it was that pedal's last take.
function deleteClip(clipId) {
  const idx = loopLibrary.findIndex((c) => c.id === clipId);
  if (idx === -1) return;
  const playing = tracks.find((t) => t.clipId === clipId || t.pendingClipId === clipId);
  if (playing) clearTrack(playing.id);
  loopLibrary.splice(idx, 1);
  const card = clipCardEls.get(clipId);
  if (card) card.remove();
  clipCardEls.delete(clipId);
  if (lastDrumClipId === clipId) lastDrumClipId = null;
  if (lastPianoClipId === clipId) lastPianoClipId = null;
  refreshTrackDeckUI();
}

// Direct Play/Stop control for a Loop Library card, as an alternative to
// dragging it onto a track. Loading still goes through loadClipOntoTrack,
// so a click-started clip gets the same quantized-to-next-bar launch as a
// dragged one; stopping is immediate, matching clearTrack's existing
// asymmetry (see clearTrack above).
function toggleClipPlayback(clipId) {
  markStarted();
  ensureEngine();
  const playing = tracks.find((t) => t.clipId === clipId || t.pendingClipId === clipId);
  if (playing) {
    clearTrack(playing.id);
    return;
  }
  const target = firstEmptyTrack();
  if (!target) return; // no free track - same no-op behavior as a drag with no drop target
  loadClipOntoTrack(target.id, clipId);
}

// Pointer-event drag-and-drop: pointerdown spawns a floating ghost that
// follows the pointer; pointerup asks whatever's under the pointer (via
// elementFromPoint, since the ghost itself would otherwise report as the
// drop target) whether it's a track lane, and if so loads the dragged clip
// there.
function makeDraggable(cardEl, clipId) {
  cardEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    markStarted();
    ensureEngine();
    const rect = cardEl.getBoundingClientRect();
    const ghost = cardEl.cloneNode(true);
    ghost.classList.add("drag-ghost");
    ghost.style.width = rect.width + "px";
    document.body.appendChild(ghost);
    positionGhost(ghost, e.clientX, e.clientY);
    trackLaneEls.forEach((el) => el.classList.add("drop-armed"));

    const move = (ev) => {
      positionGhost(ghost, ev.clientX, ev.clientY);
      const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".track-lane");
      trackLaneEls.forEach((el) => el.classList.toggle("drop-hover", el === hit));
    };
    const up = (ev) => {
      const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".track-lane");
      if (hit) loadClipOntoTrack(Number(hit.dataset.trackId), clipId);
      ghost.remove();
      trackLaneEls.forEach((el) => el.classList.remove("drop-armed", "drop-hover"));
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  });
}

function positionGhost(ghost, x, y) {
  ghost.style.left = x + "px";
  ghost.style.top = y + "px";
}

function buildTrackLane(track) {
  const lane = document.createElement("div");
  lane.className = "track-lane";
  lane.dataset.trackId = track.id;
  lane.innerHTML = `
    <span class="track-name"></span>
    <div class="track-progress"><div class="track-progress-fill"></div></div>
    <button type="button" class="track-mute-btn" title="Mute">M</button>
    <button type="button" class="track-clear-btn" title="Clear">&times;</button>
  `;
  lane.querySelector(".track-mute-btn").addEventListener("click", () => toggleTrackMute(track.id));
  lane.querySelector(".track-clear-btn").addEventListener("click", () => clearTrack(track.id));
  trackListEl.appendChild(lane);
  trackLaneEls.set(track.id, lane);
  trackProgressEls.set(track.id, lane.querySelector(".track-progress-fill"));
}

function refreshTrackDeckUI() {
  const playingClipIds = new Set();
  tracks.forEach((track) => {
    const lane = trackLaneEls.get(track.id);
    if (!lane) return;
    const clip = track.clipId !== null ? findClip(track.clipId) : null;
    const pending = track.pendingClipId !== null ? findClip(track.pendingClipId) : null;
    const shown = pending || clip;
    lane.querySelector(".track-name").textContent = shown ? shown.name : track.name;
    lane.style.setProperty("--lane-color", shown ? shown.color : "transparent");
    lane.classList.toggle("has-clip", !!clip);
    lane.classList.toggle("pending", !!pending);
    lane.classList.toggle("muted", track.muted);
    lane.querySelector(".track-mute-btn").classList.toggle("active", track.muted);
    if (track.clipId !== null) playingClipIds.add(track.clipId);
    if (track.pendingClipId !== null) playingClipIds.add(track.pendingClipId);
  });
  // Every card's Play/Stop button reflects whether its clip is currently
  // loaded (playing or pending) on any track, not just its own drag target.
  clipCardEls.forEach((card, clipId) => {
    const active = playingClipIds.has(clipId);
    const btn = card.querySelector(".loop-card-playbtn");
    btn.classList.toggle("active", active);
    btn.innerHTML = active ? "&#9632;" : "&#9654;";
  });
  // The loop-pedal Play buttons mirror the last take recorded on each pedal:
  // disabled until a first take exists, then toggle active/glyph the same
  // way a Loop Library card's own Play/Stop button does.
  syncPedalPlayBtn(drumLoopPlayBtn, lastDrumClipId, playingClipIds);
  syncPedalPlayBtn(pianoLoopPlayBtn, lastPianoClipId, playingClipIds);
}

function syncPedalPlayBtn(btn, clipId, playingClipIds) {
  btn.disabled = clipId === null;
  const active = clipId !== null && playingClipIds.has(clipId);
  btn.classList.toggle("active", active);
  btn.innerHTML = active ? "&#9632; Play" : "&#9654; Play";
}

tracks.forEach(buildTrackLane);
loopLibrary.forEach(addLoopCard); // pre-populated Style presets
refreshTrackDeckUI();

addTrackBtn.addEventListener("click", () => {
  const track = addTrack();
  if (track) { buildTrackLane(track); refreshTrackDeckUI(); }
  addTrackBtn.disabled = tracks.length >= MAX_TRACKS;
});

// Animates each track's own progress bar independently, since tracks have
// no shared length - reads the same ctx.currentTime/barStartTime the
// Constellation canvas playhead already uses, just scoped per track.
function animateTrackProgress() {
  const barDuration = STEP_COUNT * secondsPerStep();
  tracks.forEach((track) => {
    const fill = trackProgressEls.get(track.id);
    if (!fill) return;
    if (track.clipId === null || !ctx) { fill.style.width = "0%"; return; }
    const clip = findClip(track.clipId);
    if (!clip) { fill.style.width = "0%"; return; }
    let progress;
    if (clip.kind === "style") {
      // A style clip's cycle length is its trimmed loopBuffer's own real
      // seconds (stretched/compressed live by playbackRate), not lengthBars,
      // so its progress is measured against wall-clock time since it was
      // launched instead of the bar-count math below.
      if (!clip.loopBuffer || track.audioStartTime === null) { fill.style.width = "0%"; return; }
      const cycleDuration = clip.loopBuffer.duration / (track.audioSource ? track.audioSource.src.playbackRate.value : 1);
      progress = ((ctx.currentTime - track.audioStartTime) % cycleDuration) / cycleDuration;
    } else if (clip.kind === "sample") {
      // A sample clip loops at its own native speed (playbackRate stays 1),
      // so its cycle length is simply its full recording's own duration.
      if (!clip.audioBuffer || track.audioStartTime === null) { fill.style.width = "0%"; return; }
      progress = ((ctx.currentTime - track.audioStartTime) % clip.audioBuffer.duration) / clip.audioBuffer.duration;
    } else {
      const elapsedBars = (barIndex - track.startBar) + Math.min(1, Math.max(0, (ctx.currentTime - barStartTime) / barDuration));
      progress = (elapsedBars % clip.lengthBars) / clip.lengthBars;
    }
    fill.style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
  });
  requestAnimationFrame(animateTrackProgress);
}
requestAnimationFrame(animateTrackProgress);

// --- Global transport: Start/Stop pauses and resumes the entire session
//     (drum sequencer, Constellation loop, every track, sustained notes)
//     with nothing beyond ctx.suspend()/ctx.resume(). That works because
//     every timing decision in this app - the scheduler's lookahead gate,
//     every AudioParam automation, every already-started source node - is
//     expressed in terms of ctx.currentTime, which itself freezes the
//     instant the context suspends and picks back up exactly where it
//     left off on resume. No other subsystem needs to know Stop happened. ---

let globalPlaying = false;

function setGlobalPlaying(playing) {
  globalPlaying = playing;
  globalPlayBtn.classList.toggle("active", playing);
  globalPlayBtn.textContent = playing ? "■ Stop" : "▶ Start";
}

globalPlayBtn.addEventListener("click", () => {
  const hadCtx = !!ctx;
  ensureEngine();
  markStarted();
  if (!hadCtx) return; // ensureEngine() just created a context, which starts out running - nothing left to toggle
  if (globalPlaying) {
    ctx.suspend();
    setGlobalPlaying(false);
  } else {
    ctx.resume();
    setGlobalPlaying(true);
  }
});

// --- Global record: taps masterRecordDest (everything post-masterGain,
//     i.e. the whole live mix) rather than the mic, and - unlike Voice
//     Recording - hands back a downloadable file instead of a Loop
//     Library clip, since a whole-session take doesn't fit the
//     fixed-length loop model the shelf otherwise assumes. ---

let globalMediaRecorder = null;

function setGlobalRecordStatus(msg) {
  globalRecordStatusEl.textContent = msg;
}

function startGlobalRecording() {
  ensureEngine();
  const chunks = [];
  globalMediaRecorder = new MediaRecorder(masterRecordDest.stream);
  globalMediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  globalMediaRecorder.onstop = () => {
    const blob = new Blob(chunks, { type: globalMediaRecorder.mimeType });
    const ext = globalMediaRecorder.mimeType.split("/")[1]?.split(";")[0] || "webm";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `constellation-jam-${Date.now()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setGlobalRecordStatus("");
  };
  globalMediaRecorder.start();
  globalRecordBtn.classList.add("recording");
  globalRecordBtn.textContent = "■ Stop Rec";
  setGlobalRecordStatus("Recording session...");
}

function stopGlobalRecording() {
  if (globalMediaRecorder && globalMediaRecorder.state !== "inactive") globalMediaRecorder.stop();
  globalRecordBtn.classList.remove("recording");
  globalRecordBtn.textContent = "● Record";
}

globalRecordBtn.addEventListener("click", () => {
  ensureEngine();
  markStarted();
  if (globalMediaRecorder && globalMediaRecorder.state === "recording") {
    stopGlobalRecording();
  } else if (typeof MediaRecorder === "undefined") {
    setGlobalRecordStatus("Recording isn't supported in this browser.");
  } else {
    startGlobalRecording();
  }
});

// --- Voice recording: mic input becomes a new Loop Library clip kind,
//     played back through the same preMaster bus as everything else. ---

let mediaRecorder = null;
let mediaStream = null;

function setVoiceStatus(msg) {
  voiceStatusEl.textContent = msg;
}

async function startVoiceRecording() {
  ensureEngine();
  markStarted();
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setVoiceStatus("Mic access denied or unavailable.");
    return;
  }
  const chunks = [];
  mediaRecorder = new MediaRecorder(mediaStream);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    setVoiceStatus("Decoding...");
    try {
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      const lengthBars = Math.max(1, Math.round(audioBuffer.duration / (STEP_COUNT * secondsPerStep())));
      const clip = { id: nextLoopId++, kind: "voice", name: `Voice ${++voiceClipCount}`, color: CLIP_COLORS.voice, lengthBars, audioBuffer };
      loopLibrary.push(clip);
      addLoopCard(clip);
      setVoiceStatus("");
    } catch {
      setVoiceStatus("Could not decode the recording.");
    }
  };
  mediaRecorder.start();
  recordVoiceBtn.classList.add("recording");
  recordVoiceBtn.textContent = "■ Stop";
  setVoiceStatus("Recording...");
}

function stopVoiceRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  recordVoiceBtn.classList.remove("recording");
  recordVoiceBtn.textContent = "● Record Voice";
}

recordVoiceBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    stopVoiceRecording();
  } else if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    setVoiceStatus("Voice recording isn't supported in this browser.");
  } else {
    startVoiceRecording();
  }
});

// --- Effect sliders bind directly to their GainNode values ---

reverbSlider.addEventListener("input", () => { ensureEngine(); updateEffectSends(); });
delaySlider.addEventListener("input", () => { ensureEngine(); updateEffectSends(); });

// --- Tempo sliders: BPM recomputes the delay time; Swing is read live
//     inside advanceStep(), so it needs no immediate handler beyond
//     making sure the engine (and therefore the scheduler) exists ---

bpmSlider.addEventListener("input", () => { ensureEngine(); updateTempo(); });
swingSlider.addEventListener("input", () => { ensureEngine(); });

// --- Physical keyboard: A S D F G H J K L ; is the live solo instrument,
//     mirroring the on-screen piano keys 1:1. keydown starts a sustaining
//     note (ignoring OS auto-repeat); keyup releases it. Every key maps to
//     an exact scale degree - see rebuildScaleTables() - so there is no
//     chromatic, "wrong" key. ---

// --- Physical keyboard: Digit1-8 directly toggle the step-grid pads on/off
//     for rows 0-3, row-major - a distinct key footprint from the piano's,
//     so both can be played at once with no collisions. The same 8 keys
//     reach all 4 rows by holding Shift for rows 2-3. Rows 4-7 have no
//     keyboard shortcut (QWERTYUIOP now belongs to the piano). ---

window.addEventListener("keydown", (e) => {
  const kIdx = DRUM_KEY_CODES.indexOf(e.code);
  if (kIdx === -1 || e.repeat) return;
  markStarted();
  ensureEngine();
  const rowGroup = Math.floor(kIdx / 4);
  const row = e.shiftKey ? rowGroup + 2 : rowGroup;
  toggleDrumPad(row, kIdx % 4);
});

window.addEventListener("keydown", (e) => {
  const idx = KB_KEYS.indexOf(e.code);
  if (idx === -1 || e.repeat) return;
  markStarted();
  ensureEngine();
  const key = pianoKeyElements[idx];
  key.classList.add("active");
  const pos = pianoKeyCanvasPos(key);
  startVoice(e.code, KB_FREQS[idx], pos.x, pos.y);
});

window.addEventListener("keyup", (e) => {
  const idx = KB_KEYS.indexOf(e.code);
  if (idx === -1) return;
  pianoKeyElements[idx].classList.remove("active");
  releaseVoice(e.code);
});

// Build the initial scale tables now that pianoKeyElements exists.
rebuildScaleTables();
