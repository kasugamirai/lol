/** Tiny synthesized sound effects (no assets). */
class Sfx {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noiseBuf: AudioBuffer | null = null
  private last = new Map<string, number>()
  volume = 0.5
  listener = { x: 0, z: 0 }

  private armed = false
  private armHandler = () => {
    const c = this.ensure()
    if (!c) return
    if (c.state !== 'running') c.resume().then(() => this.disarm()).catch(() => {})
    else this.disarm()
  }

  get running() { return this.ctx?.state === 'running' }

  /**
   * Resume audio on the next real user activation. Touch `pointerdown` is not an activation,
   * so listen for pointerup / touchend / click / keydown (capture, passive) until the context runs.
   */
  armUnlock() {
    if (this.armed) return
    this.armed = true
    for (const t of ['pointerup', 'touchend', 'click', 'keydown']) window.addEventListener(t, this.armHandler, { capture: true, passive: true })
  }
  private disarm() {
    if (!this.armed) return
    this.armed = false
    for (const t of ['pointerup', 'touchend', 'click', 'keydown']) window.removeEventListener(t, this.armHandler, { capture: true } as EventListenerOptions)
  }

  private ensure() {
    if (this.ctx) return this.ctx
    try {
      const C = window.AudioContext || (window as any).webkitAudioContext
      this.ctx = new C()
      // iOS can drop to 'interrupted' (calls, app switch): re-arm the unlock listeners
      this.ctx.onstatechange = () => { if (this.ctx && this.ctx.state !== 'running') this.armUnlock() }
      this.master = this.ctx.createGain()
      this.master.gain.value = this.volume
      this.master.connect(this.ctx.destination)
      const len = this.ctx.sampleRate * 1
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
      const d = this.noiseBuf.getChannelData(0)
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
    } catch { this.ctx = null }
    return this.ctx
  }

  unlock() {
    const c = this.ensure()
    if (c && c.state === 'suspended') c.resume()
  }

  setVolume(v: number) {
    this.volume = v
    if (this.master) this.master.gain.value = v
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number, delay = 0) {
    const c = this.ctx!, t = c.currentTime + delay
    const o = c.createOscillator()
    const g = c.createGain()
    o.type = type
    o.frequency.setValueAtTime(freq, t)
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g).connect(this.master!)
    o.start(t)
    o.stop(t + dur + 0.05)
  }

  private noise(dur: number, vol: number, filter: BiquadFilterType, f0: number, f1?: number, delay = 0) {
    const c = this.ctx!, t = c.currentTime + delay
    const s = c.createBufferSource()
    s.buffer = this.noiseBuf
    const bf = c.createBiquadFilter()
    bf.type = filter
    bf.frequency.setValueAtTime(f0, t)
    if (f1) bf.frequency.exponentialRampToValueAtTime(f1, t + dur)
    const g = c.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    s.connect(bf).connect(g).connect(this.master!)
    s.start(t, Math.random() * 0.5)
    s.stop(t + dur + 0.05)
  }

  play(name: string, x?: number, z?: number) {
    if (this.volume <= 0) return
    const c = this.ensure()
    if (!c || !this.master || c.state !== 'running') return
    const now = performance.now()
    if (now - (this.last.get(name) ?? 0) < 45) return
    this.last.set(name, now)
    let v = 1
    if (x !== undefined && z !== undefined) {
      const d = Math.hypot(x - this.listener.x, z - this.listener.z)
      v = Math.max(0, 1 - d / 32)
      if (v <= 0.02) return
    }
    switch (name) {
      case 'swing': this.noise(0.12, 0.18 * v, 'bandpass', 2400, 700); break
      case 'hit': this.noise(0.08, 0.25 * v, 'lowpass', 1800); this.tone(140, 0.08, 'triangle', 0.15 * v, 70); break
      case 'shoot': this.noise(0.14, 0.14 * v, 'highpass', 3000, 1200); break
      case 'throw': this.noise(0.2, 0.16 * v, 'bandpass', 900, 400); break
      case 'magic': this.tone(420, 0.25, 'sine', 0.14 * v, 980); this.tone(630, 0.2, 'triangle', 0.06 * v, 1400, 0.03); break
      case 'fire': this.noise(0.35, 0.22 * v, 'lowpass', 1400, 300); break
      case 'boom': this.noise(0.45, 0.3 * v, 'lowpass', 600, 80); this.tone(90, 0.35, 'sine', 0.25 * v, 40); break
      case 'dash': this.noise(0.22, 0.2 * v, 'bandpass', 600, 2800); break
      case 'blink': this.tone(900, 0.15, 'sine', 0.14 * v, 1800); this.noise(0.1, 0.1 * v, 'highpass', 5000); break
      case 'shield': [523, 659, 784].forEach((f, i) => this.tone(f, 0.35, 'triangle', 0.07 * v, undefined, i * 0.03)); break
      case 'heal': [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.3, 'sine', 0.08 * v, undefined, i * 0.06)); break
      case 'gold': this.tone(1320, 0.12, 'square', 0.035, undefined); this.tone(1760, 0.18, 'square', 0.035, undefined, 0.06); break
      case 'levelup': [392, 523, 659, 784].forEach((f, i) => this.tone(f, 0.28, 'triangle', 0.1, undefined, i * 0.07)); break
      case 'kill': [659, 784, 988].forEach((f, i) => this.tone(f, 0.3, 'square', 0.05, undefined, i * 0.08)); break
      case 'death': this.tone(300, 0.9, 'sawtooth', 0.08, 70); break
      case 'death2': this.tone(220, 0.4, 'triangle', 0.06, 110); break
      case 'tower': this.tone(1400, 0.18, 'sawtooth', 0.05 * v, 300); break
      case 'towerhit': this.noise(0.15, 0.2 * v, 'lowpass', 1200); break
      case 'towerdown': this.noise(1.1, 0.35 * v, 'lowpass', 700, 60); this.tone(70, 0.9, 'sine', 0.3 * v, 30); break
      case 'nexus': this.noise(2.2, 0.4, 'lowpass', 900, 40); this.tone(55, 2, 'sine', 0.4, 25); break
      case 'recallstart': this.tone(330, 0.6, 'sine', 0.08 * v, 660); break
      case 'recall': [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, 0.25, 'sine', 0.08 * v, undefined, i * 0.05)); break
      case 'zap': this.tone(1800, 0.12, 'square', 0.05 * v, 200); this.noise(0.1, 0.12 * v, 'highpass', 4000); break
      case 'thunder': this.noise(0.8, 0.35 * v, 'lowpass', 2500, 100); this.tone(60, 0.6, 'sawtooth', 0.15 * v, 30); break
      case 'ult': this.tone(200, 0.5, 'sawtooth', 0.1 * v, 600); this.noise(0.4, 0.18 * v, 'bandpass', 800, 3000); break
      case 'laser': this.tone(900, 0.6, 'sawtooth', 0.09 * v, 200); this.noise(0.6, 0.2 * v, 'highpass', 2000); break
      case 'charge': this.tone(200, 0.8, 'sine', 0.1 * v, 900); break
      case 'stealth': this.tone(600, 0.4, 'sine', 0.08 * v, 150); break
      case 'ward': this.tone(880, 0.12, 'triangle', 0.08, 660); break
      case 'click': this.tone(1200, 0.04, 'square', 0.03); break
      case 'error': this.tone(220, 0.12, 'square', 0.05); break
      case 'announce': this.tone(523, 0.2, 'triangle', 0.08); this.tone(784, 0.3, 'triangle', 0.08, undefined, 0.12); break
      case 'victory': [523, 659, 784, 1046, 1318].forEach((f, i) => this.tone(f, 0.6, 'triangle', 0.12, undefined, i * 0.12)); break
      case 'defeat': [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.7, 'triangle', 0.12, undefined, i * 0.18)); break
      case 'matchfound': [659, 880, 1046].forEach((f, i) => this.tone(f, 0.35, 'sine', 0.14, undefined, i * 0.1)); break
    }
  }
}

export const sfx = new Sfx()
