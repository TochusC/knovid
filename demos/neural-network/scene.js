const trainingDigits = [
  ['00111100', '01000010', '00000010', '00011100', '00000110', '00000010', '01000010', '00111100'],
  ['00011000', '00100100', '00100100', '00011000', '00100100', '01000010', '01000010', '00111100'],
  ['00011100', '00100010', '00000010', '00001100', '00000010', '00000001', '00100001', '00011110'],
  ['00111100', '01000010', '01000010', '00111100', '01000010', '10000001', '10000001', '01111110'],
];
const unseenDigit = ['00011100', '00100010', '00000010', '00001100', '00000010', '00100001', '00011110', '00000000'];

// Four display nodes encode the ink density in four regions of the pixel grid.
function features(digit) {
  const values = [0, 0, 0, 0];
  digit.forEach((row, y) => {
    Array.from(row).forEach((value, x) => {
      values[2 * Math.floor(y / 4) + Math.floor(x / 4)] += Number(value) / 16;
    });
  });
  return values.map(value => (value - 0.3) * 3);
}

function forward(digit, model) {
  const input = features(digit);
  const hidden = model.inputWeights.map((weights, j) =>
    Math.tanh(weights.reduce((sum, weight, i) => sum + weight * input[i], model.hiddenBias[j])));
  const logits = model.outputWeights.map((weights, j) =>
    weights.reduce((sum, weight, i) => sum + weight * hidden[i], model.outputBias[j]));
  const first = 1 / (1 + Math.exp(logits[1] - logits[0]));
  return {input, hidden, scores: [first, 1 - first]};
}

const steps = (() => {
  const model = {
    inputWeights: [[0.15, -0.4, 0.5, 0.25], [0.5, 0.2, -0.5, 0.3], [0.1, 0.55, -0.22, 0.32],
      [0.26, 0.34, 0.25, -0.3], [0.55, -0.24, 0.35, -0.26]],
    outputWeights: [[0.15, -0.4, 0.32, 0.15, -0.24], [-0.2, 0.3, -0.15, 0.17, 0.2]],
    hiddenBias: [0.15, -0.05, 0.12, -0.17, 0.07],
    outputBias: [-0.4, 0.4],
  };
  const copy = () => JSON.parse(JSON.stringify(model));
  const results = [copy()];
  for (let n = 0; n < 88; n++) {
    const example = n % trainingDigits.length;
    const {input, hidden, scores} = forward(trainingDigits[example], model);
    const error = scores.map((score, j) => score - Number(j === example % 2));
    const hiddenError = hidden.map((activation, i) =>
      (1 - activation ** 2) * error.reduce((sum, value, j) => sum + model.outputWeights[j][i] * value, 0));
    const rate = 0.25;
    model.outputWeights.forEach((row, j) => {
      row.forEach((_, i) => row[i] -= rate * error[j] * hidden[i]);
      model.outputBias[j] -= rate * error[j];
    });
    model.inputWeights.forEach((row, j) => {
      row.forEach((_, i) => row[i] -= rate * hiddenError[j] * input[i]);
      model.hiddenBias[j] -= rate * hiddenError[j];
    });
    if (n % 4 === 3) results.push(copy());
  }
  return results;
})();

function renderFrame({ctx, frame, fps, width, height}) {
  const t = frame / fps;
  const W = 1280;
  const H = 720;
  const ink = '#202542';
  const muted = '#596789';
  const purple = '#6650bf';
  const blue = '#36749d';
  const font = '"PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';
  const clamp = value => Math.min(1, Math.max(0, value));
  const ease = value => { const p = clamp(value); return p * p * (3 - 2 * p); };
  const lerp = (a, b, p) => a + (b - a) * p;
  const rise = (at, duration = 0.6) => ease((t - at) / duration);

  function box(x, y, w, h, radius, fill, stroke) {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, radius);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.2; ctx.stroke(); }
  }
  function text(value, x, y, size, color = ink, weight = 500, align = 'left') {
    ctx.font = `${weight} ${size}px ${font}`;
    ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(value, x, y);
  }
  function dot(x, y, radius, fill, stroke) {
    ctx.beginPath(); ctx.arc(x, y, radius, 0, 2 * Math.PI);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.35; ctx.stroke(); }
  }
  function line(x1, y1, x2, y2, stroke, lineWidth) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke();
  }
  function aura(x, y, radius, color) {
    const tone = ctx.createRadialGradient(x, y, 0, x, y, radius);
    tone.addColorStop(0, color + '32'); tone.addColorStop(1, color + '00');
    dot(x, y, radius, tone);
  }
  function tick(x, y, color) {
    ctx.beginPath(); ctx.moveTo(x - 5, y); ctx.lineTo(x - 1.4, y + 4); ctx.lineTo(x + 6.5, y - 4);
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
  }
  function pulse(source, target, time, color, strength) {
    if (time <= 0 || time >= 1) return;
    const intensity = Math.sin(Math.PI * time);
    const x = lerp(source.x, target.x, time);
    const y = lerp(source.y, target.y, time);
    ctx.save(); ctx.globalAlpha = intensity * strength;
    aura(x, y, 21, color);
    const tail = Math.max(0, time - 0.20);
    line(lerp(source.x, target.x, tail), lerp(source.y, target.y, tail), x, y, color, 2.5);
    dot(x, y, 4.6, color); dot(x, y, 1.8, '#ffffff');
    ctx.restore();
  }

  const units = [
    {from: 0, title: 'AI 是怎样学会识别的？', pill: '输入与预测', detail: '像素转成数字，信号经过隐藏层。'},
    {from: 6.6, title: '猜错了，就调整连接', pill: '比较与训练', detail: '用正确答案算出误差，再调整连接权重。'},
    {from: 13.4, title: '换一种写法，再认一次', pill: '识别新样本', detail: '换一张没见过的图，得到新的预测。'},
  ];
  const phase = t >= units[2].from ? 2 : t >= units[1].from ? 1 : 0;
  const {from, title, pill, detail} = units[phase];
  const progress = clamp((t - 9.25) / 4.0);
  const training = ease(progress);
  const data = phase === 2 ? unseenDigit : trainingDigits[0];
  const modelIndex = (steps.length - 1) * training;
  const after = Math.min(steps.length - 1, Math.ceil(modelIndex));
  const before = Math.floor(modelIndex);
  const interpolation = modelIndex - before;
  const oldState = forward(data, steps[before]);
  const newState = forward(data, steps[after]);
  const hiddenValues = oldState.hidden.map((value, index) => lerp(value, newState.hidden[index], interpolation));
  const scoreValues = oldState.scores.map((value, index) => lerp(value, newState.scores[index], interpolation));
  const firstFlow = (t - 2.0) / 2.9;
  const testFlow = (t - 14.1) / 3.4;
  const flow = phase === 2 ? testFlow : firstFlow;
  const inputGlow = phase === 1 ? 0.75 : ease(flow * 3.0);
  const hiddenGlow = phase === 1 ? 0.73 : ease((flow - 0.32) * 3.4);
  const outputGlow = phase === 1 ? 1 : ease((flow - 0.69) * 3.6);
  const forwardOpacity = phase === 1 ? 0 : 1;
  const backtrack = (t - 7.5) / 2.1;
  const updateWave = (t - 9.15) / 4.45;

  ctx.save(); ctx.scale(width / W, height / H);
  const background = ctx.createLinearGradient(0, 0, 1220, 670);
  background.addColorStop(0, '#f4f4fe');
  background.addColorStop(0.58, '#eef2ff');
  background.addColorStop(1, '#e4eef9');
  ctx.fillStyle = background; ctx.fillRect(0, 0, W, H);
  aura(994 + Math.sin(t * 0.23) * 45, 194, 420, '#8b73d7');
  aura(246, 563, 430, '#8bc5e7');
  for (let i = 0; i < 102; i++) {
    const x = 23 + i % 17 * 12;
    const y = 561 + Math.floor(i / 17) * 12;
    dot(x, y, 0.95, '#91a0ca55');
    dot(W - x, H - y, 0.95, '#91a0ca55');
  }

  text('KNOVID', 64, 43, 17, ink, 750);
  line(144, 34, 144, 53, '#a4aed0', 1);
  text('知视', 156, 44, 16, muted, 550);
  text('手写数字识别', 1216, 44, 17, muted, 550, 'right');
  line(64, 67, 1216, 67, '#b7c2df', 1);

  ctx.save();
  ctx.globalAlpha = 0.24 + 0.76 * rise(from, 0.55);
  ctx.translate(0, 9 * (1 - rise(from, 0.55)));
  text(title, 64, 126, 46, ink, 750);
  box(1070, 105, 146, 42, 21, '#ffffffb0', '#c8c6e7');
  dot(1090, 126, 4.7, purple);
  text(pill, 1152, 126, 17, purple, 650, 'center');
  ctx.restore();

  ctx.save();
  ctx.shadowColor = '#687ba029'; ctx.shadowBlur = 29; ctx.shadowOffsetY = 13;
  box(64, 175, 1152, 407, 28, '#ffffffef'); ctx.restore();
  box(64, 175, 1152, 407, 28, '#ffffffc0', '#ced8ee');
  line(339, 197, 339, 557, '#dce1f1', 1);
  line(943, 197, 943, 557, '#dce1f1', 1);

  text('手写输入', 101, 218, 23, ink, 700);
  text(phase === 2 ? '新样本' : '训练样本', 299, 218, 15, muted, 550, 'right');
  box(94, 249, 216, 216, 20, '#f0f2fd', '#d7dff3');
  const grid = {x: 108, y: 263, cell: 23.5};
  data.forEach((row, y) => Array.from(row).forEach((value, x) => {
    const use = inputGlow * (value === '1' ? 0.96 : 0.18);
    const px = grid.x + x * grid.cell;
    const py = grid.y + y * grid.cell;
    const light = 1 + 0.05 * Math.sin(t * 4 + x + y * 2);
    box(px + 1, py + 1, grid.cell - 2.5, grid.cell - 2.5, 5, '#ffffffc0');
    ctx.save(); ctx.globalAlpha = use * 0.93 * light;
    box(px + 1, py + 1, grid.cell - 2.5, grid.cell - 2.5, 5, x < 4 ? purple : blue);
    ctx.restore();
  }));
  line(202, 268, 202, 446, '#9cadda94', 1.5);
  line(114, 357, 289, 357, '#9cadda94', 1.5);
  text('8 × 8 像素', 202, 517, 19, muted, 600, 'center');

  const inputNodes = Array.from({length: 4}, (_, i) => ({x: 430, y: 277 + i * 65}));
  const hiddenNodes = Array.from({length: 5}, (_, i) => ({x: 662, y: 255 + i * 61}));
  const outputNodes = [{x: 866, y: 322}, {x: 866, y: 440}];
  text('像素特征', 430, 219, 21, muted, 600, 'center');
  text('隐藏层', 662, 219, 21, muted, 600, 'center');
  text('输出层', 866, 219, 21, muted, 600, 'center');

  function edge(fromNode, toNode, firstWeight, nextWeight, index, startTime, color) {
    const weight = lerp(firstWeight, nextWeight, interpolation);
    const active = clamp(Math.abs(weight) / 1.35);
    line(fromNode.x, fromNode.y, toNode.x, toNode.y, '#a5b1d253', 1.15);
    ctx.save(); ctx.globalAlpha = 0.20 + (0.54 * active);
    line(fromNode.x, fromNode.y, toNode.x, toNode.y, weight > 0 ? blue : purple, 1.0 + 3.4 * active);
    ctx.restore();
    pulse(fromNode, toNode, (flow - startTime - (index % 7) * 0.023) / 0.29, color,
      forwardOpacity * (0.57 + 0.43 * active));
    if (phase === 1) {
      const delay = fromNode.x === 662 ? 0 : 0.41;
      pulse(toNode, fromNode, (backtrack - delay - (index % 4) * 0.075) / 0.52, '#a6568f', 0.85);
      if (updateWave > 0 && updateWave < 1) {
        const ripple = (updateWave * 3.5 + index * 0.095 + delay * 0.6) % 1;
        pulse(toNode, fromNode, ripple, purple, 0.50 + 0.4 * active);
      }
    }
  }
  inputNodes.forEach((node, i) => hiddenNodes.forEach((hidden, j) =>
    edge(node, hidden, steps[before].inputWeights[j][i], steps[after].inputWeights[j][i], i * 5 + j, 0.16, blue)));
  hiddenNodes.forEach((node, i) => outputNodes.forEach((output, j) =>
    edge(node, output, steps[before].outputWeights[j][i], steps[after].outputWeights[j][i], i * 2 + j, 0.55, purple)));
  const spreads = oldState.input;
  inputNodes.forEach((node, i) => {
    dot(node.x, node.y, 18, '#f8fbff', '#a8bade');
    const radius = (5 + 9 * clamp((spreads[i] + 1) / 2)) * inputGlow;
    if (radius > 0) dot(node.x, node.y, radius, blue);
  });
  hiddenNodes.forEach((node, i) => {
    const activation = Math.abs(hiddenValues[i]);
    if (hiddenGlow > 0) aura(node.x, node.y, 39, purple);
    dot(node.x, node.y, 16, '#f9f9ff', '#a3a6d4');
    const radius = hiddenGlow * (4 + 8 * activation);
    if (radius > 0) dot(node.x, node.y, radius, hiddenValues[i] < 0 ? purple : blue);
  });
  outputNodes.forEach((node, i) => {
    if (outputGlow > 0.7) aura(node.x, node.y, 63, purple);
    dot(node.x, node.y, 23, '#f3efff', '#b0a6da');
    const active = scoreValues[i] >= 0.5 && outputGlow > 0.48;
    if (active) dot(node.x, node.y, 21, purple);
    text(i === 0 ? '3' : '8', node.x, node.y + 1, 23, active ? '#ffffff' : purple, 750, 'center');
    line(891, node.y, 942, node.y, '#a4b4d4aa', active ? 2.4 : 1.25);
  });

  text('模型预测', 978, 218, 23, ink, 700);
  scoreValues.forEach((score, i) => {
    const y = outputNodes[i].y;
    const winner = score >= 0.5 && outputGlow > 0.6;
    const hue = i === 0 ? purple : blue;
    box(972, y - 37, 219, 75, 15, winner ? '#f0edfc' : '#f7f9ff', winner ? '#c9bdf3' : '#dfe4f3');
    text(i === 0 ? '3' : '8', 992, y - 8, 28, winner ? hue : ink, 750);
    text(outputGlow > 0.09 ? Math.round(score * 100) + '%' : '—', 1168, y - 8, 21, winner ? hue : muted, 650, 'right');
    box(994, y + 13, 173, 6, 3, '#dee4f3');
    if (outputGlow > 0) box(994, y + 13, Math.max(6, 173 * score * outputGlow), 6, 3, hue);
  });

  const badgeGlow = phase === 1 ? rise(6.7) : phase === 2 ? ease((testFlow - 0.90) * 4.2) : 0;
  if (badgeGlow > 0) {
    const trainingLabel = phase === 1;
    const statusColor = trainingLabel ? '#9d4a84' : '#397292';
    ctx.save(); ctx.globalAlpha = badgeGlow;
    box(973, 510, 217, 40, 10, trainingLabel ? '#f9edf5' : '#e8f3f8');
    dot(995, 530, 10, statusColor);
    if (trainingLabel) text('!', 995, 530, 15, '#ffffff', 750, 'center');
    else tick(995, 530, '#ffffff');
    text(trainingLabel ? '正确标签  3' : '识别为  3', 1013, 530, 17, statusColor, 680);
    ctx.restore();
  }

  text(detail, 64, 632, 27, muted, 550);
  text('简化模型示意', 1216, 633, 15, muted, 500, 'right');
  for (let i = 0; i < units.length; i++) {
    const x = 64 + i * 385;
    const elapsed = clamp((t - units[i].from) / ((units[i + 1]?.from ?? 20) - units[i].from));
    box(x, 670, 382, 4, 2, '#cdd6eb');
    if (elapsed > 0) box(x, 670, Math.max(4, 382 * elapsed), 4, 2, purple);
  }
  ctx.restore();
}
