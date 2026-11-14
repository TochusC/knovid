(() => {
  const canvas = document.querySelector('canvas');
  canvas.width = 960;
  canvas.height = 540;
  const ctx = canvas.getContext('2d');
  const TAU = Math.PI * 2;
  const ink = '#232846';
  const muted = '#535e7e';
  const grid = '#dce3f3';
  const lavender = '#7057cb';
  const blue = '#4178b5';
  const font = '"PingFang SC","Noto Sans CJK SC",sans-serif';
  const counts = [Array(6).fill(0)];
  const outcomes = [];
  let seed = 71;
  for (let i = 0; i < 1000; i++) {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    const die = Math.floor(seed / 2 ** 32 * 6);
    outcomes.push(die + 1);
    const next = counts.at(-1).slice();
    next[die]++;
    counts.push(next);
  }

  const rolls = [1.6, 2.35, 3.1, 3.83, 4.56, 5.27, 5.98, 6.65, 7.3, 7.96];
  const clamp = n => Math.max(0, Math.min(1, n));
  const mix = (a, b, p) => a + (b - a) * p;
  const smooth = n => clamp(n) ** 2 * (3 - 2 * clamp(n));
  const progress = (t, a, b) => smooth((t - a) / (b - a));

  function rectangle(x, y, w, h, radius, fill, stroke) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  function circle(x, y, r, fill, stroke, width = 1) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.stroke();
    }
  }
  function text(s, x, y, size, color = ink, weight = 500, align = 'left') {
    ctx.font = `${weight} ${size}px ${font}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
  }
  function line(x1, y1, x2, y2, stroke, weight = 1, dash = []) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = weight;
    ctx.setLineDash(dash);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  function polygon(pts, fill, edge) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (edge) {
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = edge;
      ctx.stroke();
    }
  }
  function blend(opacity, draw) {
    if (opacity <= 0) return;
    ctx.save();
    ctx.globalAlpha *= opacity;
    draw();
    ctx.restore();
  }

  const pips = {
    1: [[0, 0]],
    2: [[-1, -1], [1, 1]],
    3: [[-1, -1], [0, 0], [1, 1]],
    4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
    5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
    6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
  };
  const faces = [
    {value: 6, vertex: (u, v) => [u, v, 1]},
    {value: 1, vertex: (u, v) => [-u, v, -1]},
    {value: 4, vertex: (u, v) => [1, v, -u]},
    {value: 3, vertex: (u, v) => [-1, v, u]},
    {value: 2, vertex: (u, v) => [u, -1, v]},
    {value: 5, vertex: (u, v) => [u, 1, -v]},
  ];
  const orientation = [null, [0, Math.PI], [-Math.PI / 2, 0], [0, Math.PI / 2], [0, -Math.PI / 2], [Math.PI / 2, 0], [0, 0]];

  function die(x, y, size, fromValue, toValue, fraction, yawBias) {
    const f = progress(fraction, 0, 0.88);
    const [a, b] = orientation[fromValue];
    const [c, d] = orientation[toValue];
    const lean = Math.sin(Math.PI * fraction);
    const spinX = mix(a, c + TAU, f);
    const spinY = mix(b, d - TAU, f);
    function rotate([px, py, pz]) {
      const yaw = spinY;
      const pitch = spinX;
      const xx = px * Math.cos(yaw) + pz * Math.sin(yaw);
      const zz = -px * Math.sin(yaw) + pz * Math.cos(yaw);
      const yy = py * Math.cos(pitch) - zz * Math.sin(pitch);
      const z = py * Math.sin(pitch) + zz * Math.cos(pitch);
      const ax = -0.29;
      const ay = -0.37 + yawBias;
      const preliminary = yy * Math.sin(ax) + z * Math.cos(ax);
      const tx = xx * Math.cos(ay) + preliminary * Math.sin(ay);
      const ty = yy * Math.cos(ax) - z * Math.sin(ax);
      const tz = -xx * Math.sin(ay) + preliminary * Math.cos(ay);
      const roll = -0.11 + lean * 0.33;
      return [tx * Math.cos(roll) - ty * Math.sin(roll), tx * Math.sin(roll) + ty * Math.cos(roll), tz];
    }
    function project([px, py, pz]) {
      const lens = size * 7 / (7 - pz);
      return [x + px * lens, y + py * lens - 26 * lean];
    }
    const shadow = ctx.createRadialGradient(x, y + size * 1.37, 2, x, y + size * 1.37, size * 1.64);
    shadow.addColorStop(0, 'rgba(65,75,138,.29)');
    shadow.addColorStop(1, 'rgba(65,75,138,0)');
    blend(1 - 0.45 * lean, () => {
      ctx.save();
      ctx.translate(0, (y + size * 1.37) * 0.68);
      ctx.scale(1, 0.32);
      circle(x, y + size * 1.37, size * 1.64, shadow);
      ctx.restore();
    });
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const face of faces.map(face => ({...face, normal: rotate(face.vertex(0, 0))}))
      .filter(({normal}) => normal[2] * 7 > 1)
      .sort((a, b) => a.normal[2] - b.normal[2])) {
      const projected = (u, v) => project(rotate(face.vertex(u, v)));
      const plane = corners.map(corner => projected(...corner));
      const light = clamp(-0.39 * face.normal[0] - 0.55 * face.normal[1] + 0.73 * face.normal[2]);
      const edgeShade = Math.round(73 + light * 23);
      const fill = ctx.createLinearGradient(...plane[0], ...plane[2]);
      fill.addColorStop(0, `hsl(224 63% ${Math.min(100, edgeShade + 5)}%)`);
      fill.addColorStop(1, `hsl(228 55% ${edgeShade}%)`);
      polygon(plane, fill, '#a5b5e3');
      for (const [pipX, pipY] of pips[face.value]) {
        const disk = Array.from({length: 18}, (_, i) => {
          const angle = i / 18 * TAU;
          return projected(pipX * 0.48 + 0.119 * Math.cos(angle), pipY * 0.48 + 0.119 * Math.sin(angle));
        });
        polygon(disk, face.value === 6 ? '#6648c2' : '#41618f');
      }
    }
  }

  const plot = {left: 419, top: 224, w: 431, h: 181};
  const plotX = (n, max) => plot.left + (n - 1) * plot.w / (max - 1);
  const plotY = (rate, topRate) => plot.top + (1 - rate / topRate) * plot.h;
  function histogram(count, previous, reveal, opacity) {
    blend(opacity, () => {
      text('各点数出现的次数', 379, 177, 20, ink, 650);
      const max = 4;
      const baseline = plot.top + plot.h;
      for (let tick = 0; tick <= max; tick++) {
        const y = plotY(tick, max);
        line(plot.left, y, plot.left + plot.w, y, grid);
        text(String(tick), 402, y, 13, muted, 500, 'right');
      }
      for (let i = 0; i < 6; i++) {
        const x = plot.left + (i + 0.5) * plot.w / 6;
        const amount = mix(counts[previous][i], counts[count][i], reveal);
        const h = Math.max(2, amount / max * plot.h);
        const marked = i === 5;
        const changed = counts[previous][i] !== counts[count][i];
        rectangle(x - 17, plot.top, 34, plot.h, 8, marked ? '#f0eaff' : '#eef3fc');
        rectangle(x - 17, baseline - h, 34, h, 8, marked ? lavender : '#6895c7');
        if (changed && amount > 0) {
          blend(Math.sin(Math.PI * reveal), () => {
            circle(x, baseline - h, 8 + 9 * reveal, null, marked ? lavender : '#5b8bc0', 2);
          });
        }
        text(String(i + 1), x, 428, 16, marked ? lavender : muted, marked ? 750 : 500, 'center');
      }
    });
  }

  function trend(t, count, max, topRate, opacity) {
    blend(opacity, () => {
      text('点数 6 的累计频率', 379, 177, 20, ink, 650);
      circle(783, 177, 3.5, lavender);
      text('模拟结果', 794, 177, 13, muted, 550);
      for (const yRate of [0, 0.1, 0.2, 0.3, 0.4].filter(x => x <= topRate)) {
        const y = plotY(yRate, topRate);
        blend(yRate === 0 ? 1 : clamp((y - plot.top) / 11), () => {
          line(plot.left, y, plot.left + plot.w, y, grid);
          text(`${Math.round(yRate * 100)}%`, 406, y, 12, muted, 520, 'right');
        });
      }
      // The dashed line is the probability of six on each independent fair roll.
      const p = 1 / 6;
      const targetY = plotY(p, topRate);
      line(plot.left, targetY, plot.left + plot.w, targetY, '#6a85b5', 1.8, [6, 5]);
      rectangle(773, targetY - 25, 77, 18, 8, '#edf4ff');
      text('理论值 1/6', 811.5, targetY - 15.5, 11.5, '#476591', 600, 'center');

      const end = Math.floor(count);
      const xAt = n => plotX(n, max);
      const yAt = n => plotY(counts[n][5] / n, topRate);
      const trace = () => {
        ctx.beginPath();
        ctx.moveTo(xAt(1), yAt(1));
        for (let n = 2; n <= end; n++) ctx.lineTo(xAt(n), yAt(n));
      };
      ctx.save();
      ctx.beginPath();
      ctx.rect(plot.left - 4, plot.top - 4, plot.w + 8, plot.h + 8);
      ctx.clip();
      trace();
      ctx.lineTo(xAt(end), plot.top + plot.h);
      ctx.lineTo(plot.left, plot.top + plot.h);
      ctx.closePath();
      const shade = ctx.createLinearGradient(0, plot.top, 0, plot.top + plot.h);
      shade.addColorStop(0, 'rgba(119,92,209,.22)');
      shade.addColorStop(1, 'rgba(119,92,209,.035)');
      ctx.fillStyle = shade;
      ctx.fill();
      trace();
      ctx.strokeStyle = lavender;
      ctx.lineWidth = end < 100 ? 3.3 : 2.4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
      const radius = 5.5 + (Math.sin(t * 4.1) + 1) * 1.25;
      circle(xAt(end), yAt(end), radius + 4, '#e3d9fb');
      circle(xAt(end), yAt(end), 5, lavender, '#fff', 1.3);
      text('1', xAt(1), 428, 13, muted, 500, 'center');
      const step = [2, 5, 10, 25, 50, 100, 250].find(n => n >= max / 5) || 250;
      for (let n = step; n <= max; n += step) text(String(n), xAt(n), 428, 13, muted, 500, 'center');
      text('投掷次数', 850, 450, 12, muted, 500, 'right');
    });
  }

  function rollCounter(count, trendMix) {
    const rate = count ? counts[count][5] / count * 100 : 0;
    const x = 69;
    text('投掷次数', x, 380, 15, muted, 550);
    text(count.toLocaleString('en-US'), x, 419, 36, ink, 720);
    line(177, 370, 177, 432, '#dee5f5');
    text('点数 6 的频率', 195, 380, 15, muted, 550);
    text(count ? `${rate.toFixed(1)}%` : '—', 195, 419, 30, lavender, 720);
    blend(trendMix, () => {
      circle(80, 185, 4, lavender);
      text('公平骰子模拟', 94, 185, 14, muted, 600);
    });
  }

  window.drawDiceSample = function(t) {
    const total = rolls.filter(time => time <= t).length;
    const previous = Math.max(0, total - 1);
    const timeAfter = total ? t - rolls[total - 1] : 10;
    const trendMix = progress(t, 8.25, 9.1);
    const max = t < 12.7 ? mix(12, 105, progress(t, 8.85, 12.65))
      : mix(105, 1000, progress(t, 12.7, 15.7));
    const count = total < 10 ? total : Math.floor(t < 12.7
      ? mix(10, 95, progress(t, 9.0, 12.65))
      : mix(95, 1000, progress(t, 12.7, 17.15)));
    const topRate = mix(0.45, 0.37, progress(t, 13.5, 16.4));
    const bg = ctx.createLinearGradient(0, 0, 960, 540);
    bg.addColorStop(0, '#f4f1fe');
    bg.addColorStop(0.49, '#f6f8ff');
    bg.addColorStop(1, '#edf6ff');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 960, 540);
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 10; col++) {
        circle(757 + col * 14, 33 + row * 13, 1.2, '#c8d5ee');
      }
    }

    text('随机背后，也有规律', 49, 65, 36, ink, 750);
    text('反复掷一枚公平骰子，会看到什么？', 51, 111, 16, muted, 500);
    rectangle(44, 148, 281, 314, 22, '#f9faff', '#dbe2f3');
    rectangle(348, 148, 568, 314, 22, '#fcfdff', '#dbe2f3');

    const nextRoll = rolls[total] ?? Infinity;
    const rolling = t > 9.1 && t < 16.6;
    const spin = (t - 9.1) * mix(1.0, 3.0, progress(t, 9.2, 12.6));
    const visible = rolling ? count : total;
    const diceA = outcomes[visible - 1] || 6;
    const diceB = outcomes[visible] || 6;
    const landing = clamp((t - nextRoll + 0.42) / 0.42);
    const nudge = (1 - trendMix) * Math.sin(t * 2) * 4;
    die(183, 275 + nudge, 49, diceA, diceB, rolling ? spin % 1 : landing, Math.sin(t * 1.4) * 0.07);
    rollCounter(count, trendMix);
    histogram(total, previous, progress(timeAfter, 0, 0.46), 1 - trendMix);
    trend(t, Math.max(1, count), max, topRate, trendMix);

    const notes = [
      {start: 0, end: 8.35, text: '投掷次数少时，点数 6 的频率上下波动。'},
      {start: 8.35, end: 14.06, text: '把每次投掷后的累计频率连起来。'},
      {start: 14.06, end: 21, text: '投掷越多，累计频率通常越接近理论概率 1/6。'},
    ];
    for (const note of notes) {
      const enter = note.start === 0 ? 1 : progress(t, note.start, note.start + 0.24);
      const exit = 1 - progress(t, note.end - 0.24, note.end);
      blend(enter * exit, () => text(note.text, 480, 505, 18, muted, 620, 'center'));
    }
  };
})();
