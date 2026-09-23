import type { SkillDef } from './skills'

/** Dependency-free registry so data modules can register skills at load time (avoids import cycles). */
export const SKILLS = new Map<string, SkillDef>()
export function registerSkill(s: SkillDef) {
  SKILLS.set(s.id, s)
  return s
}
