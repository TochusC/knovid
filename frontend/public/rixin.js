if (new URLSearchParams(location.search).get('embedded') === '1' && window.parent !== window) {
  document.body.classList.add('rx-embedded');
  const syncTheme = () => document.documentElement.classList.toggle('dark', parent.document.documentElement.classList.contains('dark'));
  syncTheme();
  const theme = new MutationObserver(syncTheme);
  theme.observe(parent.document.documentElement, {attributes: true, attributeFilter: ['class']});
  let resizeFrame;
  const resize = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (window.frameElement) window.frameElement.style.height = Math.ceil(document.body.getBoundingClientRect().height) + 'px';
    });
  });
  resize.observe(document.body);
  window.addEventListener('pagehide', () => {theme.disconnect(); resize.disconnect(); cancelAnimationFrame(resizeFrame);}, {once: true});
}

const $ = selector => document.querySelector(selector);
const number = value => new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 1}).format(value);
let snapshot;
let dirty = false;

function notice(message, error = false) {
  $('#notice').textContent = message;
  $('#notice').dataset.error = String(error);
}

async function api(path = '', payload, method = payload === undefined ? 'GET' : 'PATCH') {
  const response = await fetch('/api/v1/rixin' + path, {credentials: 'same-origin', cache: 'no-store',
    method, ...(payload === undefined ? {} : {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)})});
  if (response.status === 204) return undefined;
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.message || result.message || '请求失败，请稍后重试');
    error.status = response.status;
    throw error;
  }
  return result;
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function renderOverview() {
  const measured = snapshot.videos.filter(video => video.views !== null);
  $('#video-count').textContent = number(snapshot.videos.length);
  $('#measured-count').textContent = number(measured.length);
  $('#total-views').textContent = number(measured.reduce((total, video) => total + video.views, 0));
  $('#auto').checked = snapshot.enabled;
  $('#auto').disabled = false;
  $('#recommended').textContent = snapshot.recommended?.style || '等待第一条播放数据';
  $('#recommend-reason').textContent = snapshot.recommended ? `来自 ${snapshot.recommended.count} 条视频 · 平均播放 ${number(snapshot.recommended.averageViews)} · 择优评分 ${number(snapshot.recommended.score)}` : '在下方为视频录入播放量，即可开始比较风格。';
  $('#method').textContent = snapshot.method;
  const rows = snapshot.ranking.map((style, index) => {
    const row = node('tr');
    const name = node('td'); name.append(node('span', String(index + 1).padStart(2, '0'), 'rx-rank'), document.createTextNode(style.style));
    row.append(name, node('td', number(style.count)), node('td', number(style.averageViews)), node('td', number(style.score)));
    return row;
  });
  if (!rows.length) {const row = node('tr'); const cell = node('td', '还没有播放数据。先为一条视频录入播放量。'); cell.colSpan = 4; row.append(cell); rows.push(row);}
  $('#ranking').replaceChildren(...rows);
}

function field(label, control) {
  const wrapper = node('label', label); wrapper.append(control); return wrapper;
}

function renderVideos() {
  const filter = $('#filter').value;
  const videos = snapshot.videos.filter(video => filter === 'all' || (filter === 'pending' ? video.views === null : video.views !== null));
  const forms = videos.map(video => {
    const form = node('form', undefined, 'rx-video');
    const title = node('h3', video.title);
    const date = new Date(video.createdAt);
    const meta = node('p', `${Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN')} · 版本 ${video.revisionId.slice(0, 8)}${video.selectedStyle ? ' · 生成时参考：' + video.selectedStyle.style : ''}`, 'rx-meta');
    const style = node('input'); style.name = 'style'; style.value = video.style; style.required = true; style.maxLength = 60;
    const views = node('input'); views.name = 'views'; views.type = 'number'; views.min = '0'; views.max = String(Number.MAX_SAFE_INTEGER); views.step = '1'; views.placeholder = '未录入'; views.value = video.views ?? ''; views.inputMode = 'numeric';
    const fields = node('div', undefined, 'rx-fields'); fields.append(field('风格名称 / 分类', style), field('播放量（手动输入）', views));
    const summary = node('textarea'); summary.name = 'summary'; summary.value = video.summary; summary.required = true; summary.maxLength = 2400; summary.rows = 5;
    const link = node('a', '查看视频 ↗'); link.href = video.videoUrl; link.target = '_blank'; link.rel = 'noopener';
    const submit = node('button', '保存复盘', 'rx-save'); submit.type = 'submit';
    const actions = node('div', undefined, 'rx-actions'); actions.append(link, submit);
    const status = node('p', video.updatedAt ? '已保存；可更新累计播放量。' : '空白表示尚未统计，填写 0 表示实际零播放。', 'rx-form-status'); status.setAttribute('role', 'status');
    form.append(title, meta, fields, field('风格摘要 · 可修订', summary), actions, status);
    form.addEventListener('input', () => {form.dataset.dirty = 'true'; dirty = true; status.textContent = '有未保存的修改';});
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const count = views.value.trim() === '' ? null : Number(views.value);
      if (count !== null && (!Number.isSafeInteger(count) || count < 0)) {status.textContent = '请输入非负整数播放量'; return;}
      submit.disabled = true; status.textContent = '正在保存…';
      try {
        const saved = await api('/' + video.projectId + '/' + video.revisionId, {style: style.value, summary: summary.value, views: count});
        Object.assign(video, saved); form.dataset.dirty = 'false'; dirty = Boolean(document.querySelector('form[data-dirty="true"]'));
        snapshot = await api(); renderOverview();
        status.textContent = '已保存，风格排名已更新'; notice('复盘已保存。');
      } catch (error) {status.textContent = error.message; notice(error.message, true);}
      finally {submit.disabled = false;}
    });
    return form;
  });
  if (!forms.length) forms.push(node('p', snapshot.videos.length ? '没有符合筛选条件的视频。' : '还没有生成成功的视频。返回创作工作台，完成第一支视频后会自动出现在这里。', 'rx-empty'));
  $('#videos').replaceChildren(...forms);
}

async function load() {
  $('#refresh').disabled = true;
  try {snapshot = await api(); dirty = false; renderOverview(); renderVideos(); notice('数据已更新。播放量需手动录入，可随时修订。');}
  catch (error) {notice('加载失败：' + error.message, true);}
  finally {$('#refresh').disabled = false;}
}

$('#auto').addEventListener('change', async () => {
  const control = $('#auto'); const enabled = control.checked; control.disabled = true;
  try {await api('', {enabled}); snapshot.enabled = enabled; renderOverview(); notice(enabled ? '未指定风格时会自动择优。' : '未指定风格时使用网站默认风格。');}
  catch (error) {control.checked = !enabled; notice(error.message, true);}
  finally {control.disabled = false;}
});
$('#filter').addEventListener('change', () => {if (dirty && !confirm('切换筛选将丢弃未保存的修改，是否继续？')) {$('#filter').value = $('#filter').dataset.previous || 'all'; return;} dirty = false; $('#filter').dataset.previous = $('#filter').value; if (snapshot) renderVideos();});
$('#refresh').addEventListener('click', () => {
  if (dirty && !confirm('刷新将丢弃未保存的修改，是否继续？')) return;
  void load();
});
window.addEventListener('beforeunload', event => {if (dirty) {event.preventDefault(); event.returnValue = '';}});
load();
