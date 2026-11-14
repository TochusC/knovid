function renderFrame({ctx, frame, fps, width, height, durationFrames, params, cues}) {
  const u = width / 640;
  const v = height / 360;
  const time = frame / fps;
  const focus = (cues.focus ?? 6) / fps;
  const progress = Math.max(0, Math.min(1, (time - focus + 0.2) / 1.8));
  const eased = progress * progress * (3 - 2 * progress);
  const number = SCENE_NUMBER;
  const title = SCENE_TITLE;
  const eccentricity = params.eccentricity;
  const semiMajor = 155;
  const semiMinor = semiMajor * Math.sqrt(1 - eccentricity ** 2);
  const centerX = 422;
  const centerY = 171;
  const sunX = centerX - semiMajor * eccentricity;
  const mean = (number === 2 ? 2.2 : 1.4) + 4.9 * eased;
  function at(M) {
    let E = M;
    for (let i = 0; i < 8; i++) E -= (E - eccentricity * Math.sin(E) - M) / (1 - eccentricity * Math.cos(E));
    return [centerX - semiMajor * Math.cos(E), centerY + semiMinor * Math.sin(E) * 0.62];
  }
  const point = at(mean);
  ctx.save();
  ctx.scale(u, v);
  const paper = ctx.createLinearGradient(0, 0, 640, 360);
  paper.addColorStop(0, '#f9f5ea');
  paper.addColorStop(1, '#e9e1ce');
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, 640, 360);
  ctx.strokeStyle = '#cbc5b6';
  ctx.lineWidth = 0.5;
  for (let x = 41; x <= 601; x += 27) {
    ctx.beginPath();
    ctx.moveTo(x, 58);
    ctx.lineTo(x, 295);
    ctx.stroke();
  }
  for (let y = 76; y <= 295; y += 27) {
    ctx.beginPath();
    ctx.moveTo(41, y);
    ctx.lineTo(601, y);
    ctx.stroke();
  }
  ctx.fillStyle = '#b35428';
  ctx.fillRect(40, 38, 26, 2);
  ctx.font = '600 11px sans-serif';
  const isChinese = /[\u3400-\u9fff]/u.test(title);
  ctx.fillText(isChinese ? '开普勒定律' : "KEPLER'S LAWS", 75, 43);
  ctx.fillStyle = '#142435';
  ctx.font = '700 28px sans-serif';
  if (isChinese) {
    ctx.fillText(title, 40, 146, 209);
  } else {
    const words = title.split(' ');
    const split = Math.ceil(words.length / 2);
    ctx.fillText(words.slice(0, split).join(' '), 40, 140, 207);
    ctx.fillText(words.slice(split).join(' '), 40, 171, 207);
  }
  ctx.strokeStyle = '#6e827e';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.ellipse(centerX, centerY, semiMajor, semiMinor * 0.62, 0, 0, 2 * Math.PI);
  ctx.stroke();
  if (params.trail) {
    const starts = number >= 3 ? [0.1, 2.8] : [mean - 0.8];
    for (const [index, initial] of starts.entries()) {
      ctx.fillStyle = index === 0 ? '#12928d48' : '#c0623348';
      ctx.strokeStyle = index === 0 ? '#096b68' : '#b35428';
      ctx.beginPath();
      ctx.moveTo(sunX, centerY);
      for (let i = 0; i <= 28; i++) ctx.lineTo(...at(initial + i * 0.8 / 28));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  const glare = ctx.createRadialGradient(sunX, centerY, 3, sunX, centerY, 24);
  glare.addColorStop(0, '#e4ae54');
  glare.addColorStop(1, '#c4692c00');
  ctx.fillStyle = glare;
  ctx.beginPath();
  ctx.arc(sunX, centerY, 24, 0, 2 * Math.PI);
  ctx.fill();
  ctx.fillStyle = '#ac481d';
  ctx.beginPath();
  ctx.arc(sunX, centerY, 5, 0, 2 * Math.PI);
  ctx.fill();
  ctx.fillStyle = '#096b68';
  ctx.strokeStyle = '#f6f0e5';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(...point, 7, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#096b68';
  ctx.fillRect(40, 211, 52 + 82 * Math.min(1, frame / durationFrames), 2);
  ctx.restore();
}
