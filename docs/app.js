'use strict';

// The sketch declares its service as "0x0FFE" and the goal weight characteristic as
// "0xFF11". ArduinoBLE parses the "0x" prefix as an extra byte, which turns them into
// these 128-bit UUIDs. The standard 16-bit forms are listed too, in case the sketch
// is ever changed to "0FFE" / "FF11".
const SERVICE_UUIDS = [
  '00000000-0000-0000-0000-000000000ffe',
  '00000ffe-0000-1000-8000-00805f9b34fb',
];
const GOAL_UUIDS = [
  '00000000-0000-0000-0000-00000000ff11',
  '0000ff11-0000-1000-8000-00805f9b34fb',
];

const MIN_GOAL = 10;  // MIN_GOAL_WEIGHT in the sketch: anything below turns brew by weight off
const MAX_GOAL = 200;
const DEFAULT_GOAL = 36;

const $ = (id) => document.getElementById(id);
const els = {
  led: $('led'), status: $('status'), connect: $('connect'),
  intro: $('intro'), introText: $('introText'),
  goal: $('goal'), form: $('goalForm'), input: $('goalInput'),
  minus: $('minus'), plus: $('plus'), save: $('save'),
  offNote: $('offNote'), bbw: $('bbw'),
};

let state = 'idle';        // idle | connecting | connected | lost | unsupported
let device = null;
let goalChar = null;
let boardGoal = null;      // goal weight last read from or saved to the shotStopper
let busy = false;

// The last goal used with brew by weight on, restored when it's switched back on
function lastGoal() {
  try {
    const g = Number(localStorage.getItem('lastGoal'));
    if (g >= MIN_GOAL && g <= MAX_GOAL) return g;
  } catch (e) { /* storage unavailable */ }
  return DEFAULT_GOAL;
}
function rememberGoal(g) {
  try { localStorage.setItem('lastGoal', String(g)); } catch (e) { /* storage unavailable */ }
}

// Web Bluetooth rejects overlapping GATT operations, so run them one at a time
let gattQueue = Promise.resolve();
function gatt(op) {
  const run = gattQueue.then(op);
  gattQueue = run.catch(() => {});
  return run;
}

function setStatus(text) { els.status.textContent = text; }

function render() {
  els.led.dataset.state = state;
  const connected = state === 'connected';

  els.connect.hidden = state === 'unsupported' || state === 'connecting' || connected;
  els.connect.textContent = state === 'lost' ? 'Reconnect' : 'Connect';
  els.intro.hidden = connected || (state === 'lost' && boardGoal !== null);
  els.goal.hidden = !els.intro.hidden;

  const on = boardGoal !== null && boardGoal >= MIN_GOAL;
  els.bbw.checked = on;
  els.goal.classList.toggle('is-off', !on);
  els.offNote.hidden = on;
  els.save.hidden = !on;

  const value = Number(els.input.value);
  const valid = Number.isInteger(value) && value >= MIN_GOAL && value <= MAX_GOAL;
  const editable = connected && on && !busy;
  els.input.disabled = !editable;
  els.minus.disabled = !editable || value <= MIN_GOAL;
  els.plus.disabled = !editable || value >= MAX_GOAL;
  els.save.disabled = !editable || !valid || value === boardGoal;
  els.bbw.disabled = !connected || busy;
}

function showGoal(g) {
  boardGoal = g;
  els.input.value = g >= MIN_GOAL ? g : lastGoal();
  if (g >= MIN_GOAL) rememberGoal(g);
}

async function findGoalCharacteristic(server) {
  for (const uuid of SERVICE_UUIDS) {
    let service;
    try { service = await server.getPrimaryService(uuid); } catch (e) { continue; }
    for (const charUuid of GOAL_UUIDS) {
      try { return await service.getCharacteristic(charUuid); } catch (e) { /* try next */ }
    }
  }
  throw new Error('This device has no goal weight setting. Is it a shotStopper?');
}

async function pickDevice() {
  // Reuse a shotStopper this site already has permission for, when the browser allows it
  if (!device && navigator.bluetooth.getDevices) {
    const known = await navigator.bluetooth.getDevices();
    device = known.find((d) => (d.name || '').startsWith('shotStopper')) || null;
  }
  if (!device) {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'shotStopper' }],
      optionalServices: SERVICE_UUIDS,
    });
  }
  device.removeEventListener('gattserverdisconnected', onDisconnected);
  device.addEventListener('gattserverdisconnected', onDisconnected);
  return device;
}

async function connect() {
  if (!(await navigator.bluetooth.getAvailability())) {
    setStatus('Bluetooth is off');
    els.introText.textContent = 'Turn on Bluetooth on this phone, then connect.';
    return;
  }
  state = 'connecting';
  setStatus('Connecting…');
  render();
  try {
    const d = await pickDevice();
    const server = await d.gatt.connect();
    goalChar = await findGoalCharacteristic(server);
    const value = await gatt(() => goalChar.readValue());
    showGoal(value.getUint8(0));
    state = 'connected';
    setStatus('Connected');
  } catch (e) {
    goalChar = null;
    if (e.name === 'NotFoundError') {
      // The device picker was closed without choosing a shotStopper
      state = boardGoal === null ? 'idle' : 'lost';
      setStatus(state === 'idle' ? 'Not connected' : 'Connection lost');
    } else {
      // A remembered device may be out of range; let the next attempt show the picker
      device = null;
      state = boardGoal === null ? 'idle' : 'lost';
      setStatus("Couldn't connect");
      els.introText.textContent = `Couldn't connect to the shotStopper. Make sure it's powered on and your phone is close to it, then try again. (${e.message})`;
    }
  }
  render();
}

function onDisconnected() {
  goalChar = null;
  if (state === 'connecting') return;
  state = 'lost';
  setStatus('Connection lost');
  render();
}

async function writeGoal(g) {
  busy = true;
  render();
  try {
    await gatt(() => goalChar.writeValueWithResponse(Uint8Array.of(g)));
    showGoal(g);
    setStatus(g >= MIN_GOAL ? `Saved ${g} g` : 'Brew by weight turned off');
  } catch (e) {
    setStatus("Couldn't save. Move closer to the shotStopper and try again.");
  } finally {
    busy = false;
    render();
  }
}

function step(delta) {
  const value = Number(els.input.value) || lastGoal();
  els.input.value = Math.min(MAX_GOAL, Math.max(MIN_GOAL, value + delta));
  render();
}

function init() {
  if (!navigator.bluetooth) {
    state = 'unsupported';
    setStatus('Bluetooth not available');
    els.introText.textContent = window.isSecureContext
      ? "This browser can't use Bluetooth. Open this page in Chrome on Android."
      : 'Bluetooth only works when this page is opened over https.';
    render();
    return;
  }

  els.connect.addEventListener('click', connect);
  els.minus.addEventListener('click', () => step(-1));
  els.plus.addEventListener('click', () => step(1));
  els.input.addEventListener('input', render);
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!els.save.disabled) writeGoal(Number(els.input.value));
  });
  els.bbw.addEventListener('change', () => {
    // A goal under MIN_GOAL turns brew by weight off on the shotStopper
    writeGoal(els.bbw.checked ? lastGoal() : 0);
  });

  render();
}

init();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}
