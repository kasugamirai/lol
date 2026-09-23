import * as THREE from 'three'

/** shared fog-of-war uniforms, injected into world materials */
export const fowUniforms = {
  fowTex: { value: null as THREE.Texture | null },
  fowSize: { value: 180 },
  fowDark: { value: 0.38 },
  fowOn: { value: 1 },
}

export function patchFow<T extends THREE.Material>(m: T): T {
  m.onBeforeCompile = shader => {
    shader.uniforms.fowTex = fowUniforms.fowTex
    shader.uniforms.fowSize = fowUniforms.fowSize
    shader.uniforms.fowDark = fowUniforms.fowDark
    shader.uniforms.fowOn = fowUniforms.fowOn
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFowUv;\nuniform float fowSize;')
      .replace('#include <project_vertex>', `#include <project_vertex>
  vec4 fowWp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  fowWp = instanceMatrix * fowWp;
  #endif
  fowWp = modelMatrix * fowWp;
  vFowUv = fowWp.xz / fowSize;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFowUv;\nuniform sampler2D fowTex;\nuniform float fowDark;\nuniform float fowOn;')
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
  if (fowOn > 0.5) {
    float fv = texture2D(fowTex, vFowUv).r;
    gl_FragColor.rgb *= mix(fowDark, 1.0, fv);
  }`)
  }
  m.customProgramCacheKey = () => 'fow'
  return m
}

const lambertCache = new Map<string, THREE.MeshLambertMaterial>()
export function lambert(color: number, opts: { emissive?: number; fow?: boolean; flat?: boolean; transparent?: boolean; opacity?: number } = {}) {
  const key = `${color}|${opts.emissive ?? 0}|${opts.fow ? 1 : 0}|${opts.flat ? 1 : 0}|${opts.opacity ?? 1}`
  let m = lambertCache.get(key)
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, emissive: opts.emissive ?? 0, flatShading: !!opts.flat, transparent: !!opts.transparent || (opts.opacity ?? 1) < 1, opacity: opts.opacity ?? 1 })
    if (opts.fow) patchFow(m)
    lambertCache.set(key, m)
  }
  return m
}

export const vcMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
export const vcMatFow = patchFow(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }))

const glowCache = new Map<string, THREE.MeshBasicMaterial>()
export function glow(color: number, opacity = 1, additive = true, depthWrite = false) {
  const key = `${color}|${opacity}|${additive}|${depthWrite}`
  let m = glowCache.get(key)
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    })
    glowCache.set(key, m)
  }
  return m
}

/** a fresh (non-cached) transparent material for per-instance fading */
export function fadeMat(color: number, opacity = 1, additive = true, side: THREE.Side = THREE.FrontSide) {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, side,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  })
}

export const TEAM_COLORS = [0x3d8bff, 0xff4b4b, 0xd9b44a] as const
export const TEAM_DARK = [0x1d3f7a, 0x7a1d1d, 0x6a5a2a] as const

const crystalCache = new Map<number, THREE.MeshPhongMaterial>()
/** faceted, self-lit crystal material */
export function crystal(color: number) {
  let m = crystalCache.get(color)
  if (!m) {
    const c = new THREE.Color(color)
    m = new THREE.MeshPhongMaterial({
      color: c, emissive: c.clone().multiplyScalar(0.55), specular: 0xffffff, shininess: 90, flatShading: true,
      transparent: true, opacity: 0.92,
    })
    crystalCache.set(color, m)
  }
  return m
}
