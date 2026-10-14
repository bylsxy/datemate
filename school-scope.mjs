/** 学校选择从属于活动范围，校区选择从属于学校；无效输入不会扩大专属地点权限。 */
export function normalizeSchoolScope(input = {}) {
  const area = input.area === 'nearby' ? 'near' : input.area;
  const school = ['campus', 'near'].includes(area) && input.school === 'scau' ? 'scau' : '';
  return { school, campusArea: school && input.campusArea === 'taishan' ? 'taishan' : '' };
}

/** UI、自动规划和人工选择共用的地点范围判断，接受知识源或编译后的场景。 */
export function isSceneInSchoolScope(scene, context = {}) {
  if (!scene) return false;
  const area = context.area === 'nearby' ? 'near' : context.area;
  const sceneArea = scene.area === 'nearby' ? 'near' : scene.area || scene.areaClass || 'campus';
  if (area === 'campus' && !['campus', 'current'].includes(sceneArea)) return false;
  if (area === 'near' && !['campus', 'near', 'current'].includes(sceneArea)) return false;
  const { school, campusArea } = normalizeSchoolScope(context);
  // 旧编译目录的 scauOnly 也必须守住权限边界，直至目录统一重新生成。
  const sceneSchool = scene.place?.universityId || (scene.scauOnly === true ? 'scau' : '');
  const sceneCampusArea = scene.place?.campusArea || '';
  if (sceneCampusArea && !sceneSchool) return false;
  if (!sceneSchool) return true;
  if (sceneSchool !== school) return false;
  // 学校级场景不限定宿舍区；具体宿舍区场景须由用户显式选择该区。
  return !sceneCampusArea || sceneCampusArea === campusArea;
}
