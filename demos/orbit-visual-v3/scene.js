// Deterministic Canvas scene. Time is in seconds; the orbit uses linear mean anomaly.
function renderFrame({ctx, frame, fps, width, height, params}) {
  const t = frame / fps;
  const W = 1920, H = 1080, TAU = Math.PI * 2;
  const C = {white: '#edf6f3', muted: '#90a9b1', dim: '#4c6575', teal: '#80ead8', gold: '#f7bd72'};
  const clamp = x => Math.min(1, Math.max(0, x));
  const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
  const enter = (at, span = 0.6) => smooth((t - at) / span);
  const phase = [1 - enter(2.75, 0.4), enter(2.75, 0.4) * (1 - enter(5.85, 0.45)), enter(5.85, 0.45)];
  const a = 490, e = 0.62, b = a * Math.sqrt(1 - e * e);
  const rotation = -0.16;
  const zoom = 1 + 0.035 * phase[1];
  const cx = 1240, cy = 527;
  const rot = (x, y) => ({x: cx + zoom * (x * Math.cos(rotation) - y * Math.sin(rotation)),
    y: cy + zoom * (x * Math.sin(rotation) + y * Math.cos(rotation))});
  const sun = rot(a * e, 0);
  function orbit(M) {
    let E = M;
    for (let i = 0; i < 12; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    return {...rot(a * Math.cos(E), b * Math.sin(E)), E};
  }
  function text(value, x, y, size, color = C.white, weight = 400, align = 'left', family = '"PingFang SC", "Noto Sans CJK SC", sans-serif') {
    ctx.font = `${weight} ${size}px ${family}`;
    ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
    ctx.fillText(value, x, y);
  }
  function line(points, color, weight = 1) {
    ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.strokeStyle = color; ctx.lineWidth = weight; ctx.stroke();
  }
  function dot(p, radius, color) {
    ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, TAU); ctx.fillStyle = color; ctx.fill();
  }
  function glow(p, radius, color, opacity = 1) {
    ctx.save(); ctx.globalAlpha *= opacity;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
    g.addColorStop(0, color); g.addColorStop(1, color.slice(0, 7) + '00');
    ctx.fillStyle = g; ctx.fillRect(p.x - radius, p.y - radius, 2 * radius, 2 * radius); ctx.restore();
  }
  function arc(M0, M1, color, weight = 2) {
    line(Array.from({length: 101}, (_, i) => orbit(M0 + (M1 - M0) * i / 100)), color, weight);
  }
  function sphere(p, r, color, bright) {
    glow(p, r * 4.6, color + '35');
    const light = ctx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.35, r * 0.05, p.x + r * 0.28, p.y + r * 0.2, r * 1.15);
    light.addColorStop(0, bright); light.addColorStop(0.42, color); light.addColorStop(1, '#122733');
    dot(p, r, light);
    ctx.save(); ctx.globalAlpha *= 0.35; ctx.strokeStyle = bright; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(p.x, p.y, r + 1.2, -2.8, -0.2); ctx.stroke(); ctx.restore();
  }
  ctx.save(); ctx.scale(width / W, height / H);
  ctx.fillStyle = '#07121d'; ctx.fillRect(0, 0, W, H);
  const bg = ctx.createRadialGradient(1320, 500, 20, 1180, 500, 1030);
  bg.addColorStop(0, '#18333d'); bg.addColorStop(0.55, '#0c1c2a'); bg.addColorStop(1, '#07101b');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  glow({x: 1710, y: 250}, 540, '#42648615');
  // Fixed star positions and gentle brightness changes avoid random frame flicker.
  for (let i = 0; i < 155; i++) {
    const x = ((i * 641 + 193) % 1832) + 44;
    const y = ((i * i * 107 + 137) % 922) + 78;
    const opacity = (x < 670 ? 0.12 : 0.25) * (0.75 + 0.25 * Math.sin(i * 2.14 + t * 0.35));
    dot({x, y}, i % 11 === 0 ? 1.55 : 0.8, `rgba(189,222,236,${opacity})`);
  }
  // Quiet editorial frame.
  text('KNOVID', 114, 78, 25, C.white, 650, 'left', 'Arial, sans-serif');
  text('知视', 243, 78, 24, C.muted, 400);
  text('ORBITAL MOTION', 1805, 78, 18, '#8ba4b3', 400, 'right', 'Arial, sans-serif');
  line([{x: 114, y: 109}, {x: 1806, y: 109}], '#b3ced416');
  text('开普勒第一、第二定律', 1806, 1014, 20, '#8198a5', 400, 'right');
  text('轨道与天体尺寸为示意', 1806, 1043, 16, '#526d7b', 400, 'right');

  // Orbit: no vertical squash, so the sun remains a geometric focus.
  ctx.save(); ctx.globalAlpha = 0.30;
  ctx.setLineDash([2, 16]);
  ctx.beginPath(); ctx.ellipse(cx, cy, a * zoom + 18, b * zoom + 18, rotation, 0, TAU);
  ctx.strokeStyle = '#7393a9'; ctx.lineWidth = 0.8; ctx.stroke(); ctx.setLineDash([]); ctx.restore();
  arc(0, TAU, '#aad9e017', 10);
  arc(0, TAU, '#8aaab269', 1.6);
  for (let i = 0; i < 24; i++) {
    const p = orbit(i * TAU / 24);
    dot(p, 1.8, '#90b7bc75');
  }

  const M = (t - 4.0) * TAU / 8.2;
  const planet = orbit(M);
  // First two phrases: the same moving planet, with a trail measured in time.
  ctx.save(); ctx.globalAlpha = (1 - phase[2]);
  for (let i = 0; i < 78; i++) {
    const p = orbit(M - (78 - i) * 0.0046);
    dot(p, 1 + 3.0 * i / 78, `rgba(122,237,219,${0.02 + 0.45 * (i / 78) ** 2})`);
  }
  arc(M - 0.35, M, '#a7fce7a0', 2);
  line([sun, planet], '#d4e3cb23', 1);
  sphere(planet, 12.5, '#58baaa', '#ddfff3');
  ctx.restore();

  // Faint focus construction only while the first law is being introduced.
  ctx.save(); ctx.globalAlpha = phase[0] * enter(0.45);
  const focus2 = rot(-a * e, 0);
  line([focus2, sun], '#8aa2b33e', 1);
  line([{x: focus2.x - 5, y: focus2.y}, {x: focus2.x + 5, y: focus2.y}], '#7597a080');
  line([{x: focus2.x, y: focus2.y - 5}, {x: focus2.x, y: focus2.y + 5}], '#7597a080');
  text('另一焦点', focus2.x - 10, focus2.y + 36, 19, '#65818e', 400, 'right');
  ctx.restore();

  // Equal-time sweeps are driven by equal changes in mean anomaly.
  const reveal = clamp((t - 6.2) / 2.15);
  const span = 0.62;
  function sector(start, color, label, labelAt, index) {
    const finish = start + span * reveal;
    const boundary = Array.from({length: 161}, (_, i) => orbit(start + (finish - start) * i / 160));
    ctx.beginPath(); ctx.moveTo(sun.x, sun.y); boundary.forEach(p => ctx.lineTo(p.x, p.y)); ctx.closePath();
    const fill = ctx.createLinearGradient(sun.x, sun.y, orbit(start + span / 2).x, orbit(start + span / 2).y);
    fill.addColorStop(0, color + '09'); fill.addColorStop(1, color + '59');
    ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = color + '70'; ctx.lineWidth = 1.5; ctx.stroke();
    arc(start, start + span, color + '35', 2);
    arc(start, finish, color, 3.1);
    const p = orbit(finish); sphere(p, 7.7, color, '#f3fff7');
    const initial = orbit(start); dot(initial, 3.5, color);
    const anchor = orbit(start + span / 2);
    line([anchor, {x: labelAt.x - 17, y: labelAt.y - 10}], color + '70', 1);
    text(label, labelAt.x, labelAt.y, 23, color, 500);
    text('Δt 相同', labelAt.x, labelAt.y + 31, 18, '#9eb4bd', 400);
    const mark = {x: sun.x + (anchor.x - sun.x) * 0.69, y: sun.y + (anchor.y - sun.y) * 0.69};
    text('A' + index, mark.x, mark.y + 6, 30, color, 500, 'center', 'Georgia, serif');
  }
  ctx.save(); ctx.globalAlpha = phase[2];
  sector(-span / 2, C.gold, '近太阳', {x: 1750, y: 398}, '₁');
  sector(Math.PI - span / 2, C.teal, '远太阳', {x: 799, y: 790}, '₂');
  ctx.restore();

  // The sun has a soft corona, a rim and a granular luminous surface.
  glow(sun, 138, '#ffb4551b'); glow(sun, 70, '#ffba5632'); glow(sun, 40, '#ffd57857');
  const solar = ctx.createRadialGradient(sun.x - 9, sun.y - 10, 1, sun.x + 2, sun.y + 3, 24);
  solar.addColorStop(0, '#fffae1'); solar.addColorStop(0.4, '#ffe4a3'); solar.addColorStop(0.84, '#ffb456'); solar.addColorStop(1, '#da7236');
  dot(sun, 22, solar);
  ctx.save(); ctx.beginPath(); ctx.arc(sun.x, sun.y, 21, 0, TAU); ctx.clip();
  for (let i = 0; i < 52; i++) {
    const r = 21 * Math.sqrt((i + 0.5) / 52), angle = i * 2.399;
    dot({x: sun.x + r * Math.cos(angle), y: sun.y + r * Math.sin(angle)}, 1.5, '#ffffff16');
  }
  ctx.restore();
  text('太阳', sun.x, sun.y + 56, 23, '#e9cb97', 500, 'center');
  ctx.save(); ctx.globalAlpha = phase[0]; text('位于焦点', sun.x, sun.y + 83, 17, '#8f9e9f', 400, 'center'); ctx.restore();

  // Three text beats follow the existing narration, without a hard visual cut.
  const copy = [
    {tag: '01  /  椭圆轨道', title: ['沿着椭圆', '绕日而行'], detail: '太阳，位于其中一个焦点。', color: C.teal},
    {tag: '02  /  速度变化', title: ['靠近太阳', '行星更快'], detail: '同一颗行星，速度随位置改变。', color: C.gold},
    {tag: '03  /  等时等面积', title: ['同样的时间', '同样的面积'], detail: '形状不同，扫过的面积相等。', color: C.teal},
  ];
  copy.forEach((item, index) => {
    if (phase[index] < 0.001) return;
    const arrival = index === 0 ? enter(0, 0.6) : index === 1 ? enter(2.75, 0.4) : enter(5.85, 0.45);
    ctx.save(); ctx.globalAlpha = phase[index]; ctx.translate(0, 14 * (1 - arrival));
    ctx.fillStyle = item.color; ctx.fillRect(116, 250, 35, 3);
    text(item.tag, 169, 258, 23, item.color, 450);
    text(item.title[0], 109, 380, index === 2 ? 76 : 86, C.white, 600);
    text(item.title[1], 109, 482, index === 2 ? 76 : 86, C.white, 600);
    text(item.detail, 116, 545, 25, C.muted);
    if (index === 0) {
      text('KEPLER  /  I', 116, 650, 20, '#607d8b', 400, 'left', 'Arial, sans-serif');
    }
    if (index === 1) {
      const values = [['近日点', 1, C.gold], ['远日点', (1 - e) / (1 + e), '#83b3ba']];
      values.forEach(([label, value, color], i) => {
        const y = 627 + 49 * i;
        text(label, 116, y, 21, color);
        ctx.fillStyle = '#7b9ca21d'; ctx.fillRect(215, y - 13, 220, 6);
        ctx.fillStyle = color; ctx.fillRect(215, y - 13, 220 * value * arrival, 6);
      });
      text('轨道两端的速度对比', 116, 718, 18, '#607d8b');
    }
    if (index === 2) {
      ctx.globalAlpha *= enter(7.47, 0.6);
      text('A₁', 118, 673, 68, C.gold, 400, 'left', 'Georgia, serif');
      text('=', 225, 667, 50, '#9eb7bf', 300);
      text('A₂', 291, 673, 68, C.teal, 400, 'left', 'Georgia, serif');
      text('Δt₁ = Δt₂', 120, 727, 25, '#a4bcc3', 400, 'left', 'Georgia, serif');
    }
    ctx.restore();
  });

  // A restrained chapter indicator and readable narration captions.
  const chapter = phase[2] > 0.5 ? 2 : phase[1] > 0.5 ? 1 : 0;
  const names = ['椭圆', '速度', '面积'];
  names.forEach((name, i) => {
    const x = 116 + i * 115;
    ctx.fillStyle = i === chapter ? C.teal : '#4e697754'; ctx.fillRect(x, 935, 86, 2);
    text(name, x, 965, 17, i === chapter ? '#c5dedc' : '#567381', 400);
  });
  const caption = (params.captions || []).find(caption => caption.start <= t && t < caption.end);
  if (caption) {
    ctx.font = '450 32px "PingFang SC", "Noto Sans CJK SC", sans-serif';
    const size = ctx.measureText(caption.text).width;
    ctx.fillStyle = '#06111dd9'; ctx.beginPath(); ctx.roundRect((W - size) / 2 - 25, 983, size + 50, 60, 13); ctx.fill();
    text(caption.text, W / 2, 1024, 32, '#e6f0f0', 450, 'center');
  }
  ctx.fillStyle = '#80ead862'; ctx.fillRect(0, H - 3, W * clamp(t / 12), 3);
  ctx.restore();
}
