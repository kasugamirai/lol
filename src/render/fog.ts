import * as THREE from 'three'
import { fowUniforms } from './mats'

/** Smoothly animated fog-of-war texture (1 texel = 1 world unit). */
export class FogTexture {
  readonly tex: THREE.DataTexture
  private data: Uint8Array
  private cur: Float32Array
  constructor(public S: number) {
    this.data = new Uint8Array(S * S).fill(255)
    this.cur = new Float32Array(S * S).fill(1)
    this.tex = new THREE.DataTexture(this.data, S, S, THREE.RedFormat, THREE.UnsignedByteType)
    this.tex.magFilter = THREE.LinearFilter
    this.tex.minFilter = THREE.LinearFilter
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping
    this.tex.needsUpdate = true
    fowUniforms.fowTex.value = this.tex
    fowUniforms.fowSize.value = S
  }

  update(dt: number, vis: Uint8Array | null) {
    const k = Math.min(1, dt * 7)
    const d = this.data, c = this.cur
    const n = d.length
    for (let i = 0; i < n; i++) {
      const t = vis ? (vis[i] ? 1 : 0) : 1
      const v = c[i] + (t - c[i]) * k
      c[i] = v
      d[i] = (v * 255) | 0
    }
    this.tex.needsUpdate = true
  }

  dispose() {
    this.tex.dispose()
  }
}
