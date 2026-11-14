import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {Fault, hash, json, maybe, projectDir, read, record, revisionDir, root} from './common.mjs';
import {listProjects, metadata, withProjectLock} from './projects.mjs';
import {builtinStyles} from './builtin-styles.mjs';

const settingsFile = owner => join(root, 'rixin', hash(owner) + '.json');
const stylesFile = owner => join(root, 'rixin', hash(owner) + '.styles.json');
const feedbackFile = job => join(revisionDir(job), 'rixin.json');
const invalid = message => new Fault('INVALID_INPUT', message, {status: 400});
const key = name => name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN');
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

async function settings(owner) {
  return await maybe(settingsFile(owner)) ? read(settingsFile(owner)) : {enabled: true};
}

export function rankStyles(videos) {
  const measured = videos.filter(video => Number.isSafeInteger(video.views) && video.views >= 0);
  const baseline = measured.length ? measured.reduce((sum, video) => sum + video.views, 0) / measured.length : 0;
  const groups = new Map();
  for (const video of measured) {
    const id = key(video.style);
    const group = groups.get(id) || {style: video.style, count: 0, totalViews: 0, best: video};
    group.count++;
    group.totalViews += video.views;
    if (video.views > group.best.views) group.best = video;
    groups.set(id, group);
  }
  return [...groups.values()].map(({best, ...group}) => ({...group,
    averageViews: group.totalViews / group.count,
    score: (group.totalViews + 2 * baseline) / (group.count + 2),
    summary: best.summary, sourceProjectId: best.projectId, sourceRevisionId: best.revisionId,
  })).sort((a, b) => b.score - a.score || b.count - a.count || a.style.localeCompare(b.style, 'zh-CN'));
}

export async function rixinSnapshot(owner) {
  const videos = [];
  for (const project of (await listProjects()).filter(project => project.owner === owner)) {
    const {options} = await read(join(projectDir(project.id), 'input.json'));
    for (const revisionId of project.revisionIds) {
      const job = {projectId: project.id, revisionId};
      const dir = revisionDir(job);
      const status = await read(join(dir, 'status.json'));
      if (status.status !== 'succeeded') continue;
      const planFile = join(dir, 'plan.json');
      if (!await maybe(planFile)) continue;
      const plan = await read(planFile);
      const saved = await maybe(feedbackFile(job)) ? await read(feedbackFile(job)) : {};
      const artDirection = typeof plan.artDirection === 'string' ? plan.artDirection : '';
      const scenes = Array.isArray(plan.scenes) ? plan.scenes : [];
      const summary = [artDirection, ...scenes.map(scene => scene.title + '：' + scene.visual)].filter(Boolean).join('\n').slice(0, 2400);
      videos.push({...job, title: plan.title, createdAt: revisionId === project.revisionIds[0] ? project.createdAt : status.updatedAt,
        style: saved.style || options.styleSelection?.style || artDirection.slice(0, 60) || '未分类',
        summary: saved.summary || summary, views: saved.views ?? null, updatedAt: saved.updatedAt || null,
        selectedStyle: options.styleSelection || null,
        videoUrl: '/api/v1/projects/' + project.id + '/revisions/' + revisionId + '/artifacts/video.mp4'});
    }
  }
  const preferences = await settings(owner);
  const ranking = rankStyles(videos);
  return {enabled: preferences.enabled, videos, ranking, recommended: ranking[0] || null,
    method: '按风格分组，以平均播放量为基础，加入全体平均播放量的两个先验样本进行平滑；未录入的数据不参与，0 播放量参与。'};
}

export async function saveRixin(owner, projectId, revisionId, payload) {
  if (!record(payload) || !text(payload.style, 60) || !text(payload.summary, 2400) ||
    !(payload.views === null || Number.isSafeInteger(payload.views) && payload.views >= 0)) {
    throw invalid('请填写风格名称（1–60 字）、风格摘要（1–2400 字）和非负整数播放量；留空播放量传 null。');
  }
  return withProjectLock(projectId, async () => {
    const project = await metadata(projectId);
    if (project.owner !== owner || !project.revisionIds.includes(revisionId)) throw new Fault('NOT_FOUND', 'Video does not exist', {status: 404});
    const job = {projectId, revisionId};
    if ((await read(join(revisionDir(job), 'status.json'))).status !== 'succeeded') throw invalid('只能记录生成成功的视频。');
    const saved = {style: payload.style.trim(), summary: payload.summary.trim(), views: payload.views, updatedAt: new Date().toISOString()};
    await json(feedbackFile(job), saved);
    return saved;
  });
}

export async function saveRixinSettings(owner, payload) {
  if (!record(payload) || typeof payload.enabled !== 'boolean') throw invalid('enabled must be a boolean');
  await withProjectLock('rixin-' + hash(owner), () => json(settingsFile(owner), {enabled: payload.enabled}));
  return {enabled: payload.enabled};
}

export async function listStyles(owner) {
  const file = stylesFile(owner);
  return {presets: await maybe(file) ? await read(file) : []};
}

const missingStyle = () => new Fault('STYLE_PRESET_NOT_FOUND', '所选风格已不存在，请重新选择。', {status: 404});

export async function saveStyle(owner, id, payload) {
  if (!record(payload) || Object.keys(payload).length !== 2 || !text(payload.style, 60) || !text(payload.summary, 2400)) {
    throw invalid('请填写风格名称（1–60 字）和风格说明（1–2400 字）。');
  }
  const style = payload.style.trim();
  const summary = payload.summary.trim();
  return withProjectLock('rixin-styles-' + hash(owner), async () => {
    const {presets} = await listStyles(owner);
    const index = presets.findIndex(preset => preset.id === id);
    if (id && index < 0) throw missingStyle();
    if (presets.some(preset => preset.id !== id && key(preset.style) === key(style))) {
      throw new Fault('STYLE_PRESET_EXISTS', '已存在同名风格，请更换名称。', {status: 409});
    }
    const preset = {id: id ?? randomUUID(), style, summary};
    if (index < 0) presets.push(preset);
    else presets[index] = preset;
    await json(stylesFile(owner), presets);
    return preset;
  });
}

export async function removeStyle(owner, id) {
  return withProjectLock('rixin-styles-' + hash(owner), async () => {
    const {presets} = await listStyles(owner);
    const remaining = presets.filter(preset => preset.id !== id);
    if (remaining.length === presets.length) throw missingStyle();
    await json(stylesFile(owner), remaining);
    return {id};
  });
}

export async function applyRixin(owner, payload) {
  const {stylePresetId} = payload.options;
  if (stylePresetId === 'default') return payload;
  if (Object.hasOwn(builtinStyles, stylePresetId)) {
    const styleSelection = {presetId: stylePresetId, ...builtinStyles[stylePresetId], selectedAt: new Date().toISOString()};
    return {...payload, options: {...payload.options, styleSelection}};
  }
  if (stylePresetId && stylePresetId !== 'auto') {
    const {presets} = await listStyles(owner);
    const preset = presets.find(item => item.id === stylePresetId);
    if (!preset) throw missingStyle();
    const {id, style, summary} = preset;
    return {...payload, options: {...payload.options, styleSelection: {presetId: id, style, summary, selectedAt: new Date().toISOString()}}};
  }
  if (!stylePresetId && !(await settings(owner)).enabled) return payload;
  const {recommended} = await rixinSnapshot(owner);
  if (!recommended) return payload;
  const {style, summary, score, count, sourceProjectId, sourceRevisionId} = recommended;
  return {...payload, options: {...payload.options, styleSelection: {style, summary, score, count, sourceProjectId, sourceRevisionId, selectedAt: new Date().toISOString()}}};
}
