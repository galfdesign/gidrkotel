// Константы и утилиты
const CP_FACTOR_M3H = 0.86; // G[m3/h] = 0.86 * Q[kW] / dT[K]
const KPA_PER_M = 9.6; // приблизительно при 60–70 °C: 1 м ≈ 9.6 кПа

// Пресеты котлов и ступени насоса
const BOILERS = {
  condensing_generic: {
    title: 'Конденсационный газовый (типовой 24–35 кВт)',
    steps: [
      { label: 'III', H0: 5.0, Qmax: 2.70 },
      { label: 'II', H0: 4.2, Qmax: 2.40 },
      { label: 'I',  H0: 3.2, Qmax: 2.00 },
    ],
    dpRef: 0.30,   // м при qRef (более реалистичный для большинства моделей)
    qRef: 1.50,
  },
  gas_traditional_generic: {
    title: 'Традиционный газовый (атмосферный, настенный 24–28 кВт)',
    steps: [
      { label: 'III', H0: 4.2, Qmax: 2.50 },
      { label: 'II', H0: 3.5, Qmax: 2.20 },
      { label: 'I',  H0: 2.8, Qmax: 1.90 },
    ],
    dpRef: 0.20,
    qRef: 1.50,
  },
  electric_generic: {
    title: 'Электрический (настенный 6–24 кВт)',
    steps: [
      { label: 'III', H0: 6.0, Qmax: 2.70 },
      { label: 'II', H0: 4.8, Qmax: 2.30 },
      { label: 'I',  H0: 3.6, Qmax: 2.00 },
    ],
    dpRef: 0.12,
    qRef: 1.50,
  },
};

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function toNum(id) {
  const el = document.getElementById(id);
  return el && el.value !== '' ? Number(el.value) : 0;
}

function computeFlows(inputs) {
  const { qRad, dTRad, qUFH, dTUFH, tBoiler, tUFHSupply } = inputs;
  const gRad = (qRad > 0 && dTRad > 0) ? CP_FACTOR_M3H * qRad / dTRad : 0; // м3/ч
  const gUFHLoop = (qUFH > 0 && dTUFH > 0) ? CP_FACTOR_M3H * qUFH / dTUFH : 0; // м3/ч

  const tUFHReturn = tUFHSupply - dTUFH; // °C
  // Доля подмеса из котла x при трехходовом клапане
  let x = 0;
  if (tBoiler > tUFHReturn) {
    x = (tUFHSupply - tUFHReturn) / (tBoiler - tUFHReturn);
    x = clamp(x, 0, 1);
  }
  const gUFHPrimary = gUFHLoop * x; // м3/ч из котла на узел смесителя
  const gTotal = gRad + gUFHPrimary;

  return { gRad, gUFHLoop, gUFHPrimary, gTotal, x, tUFHReturn };
}

function branchK(hRef, gRef) {
  if (hRef <= 0 || gRef <= 0) return 0;
  return hRef / (gRef * gRef); // k в формуле H = k·G²
}

function branchHead(k, g) { return k * g * g; }

function pumpHead(h0, gmax, g) {
  if (h0 <= 0 || gmax <= 0) return 0;
  const ratio = g / gmax;
  if (ratio >= 1) return 0;
  const h = h0 * (1 - ratio * ratio);
  return h > 0 ? h : 0;
}

// Устанавливает значения насоса и внутреннего сопротивления по выбранному пресету/ступени
function applyBoilerPreset(typeKey, stepLabel) {
  const preset = BOILERS[typeKey];
  if (!preset) return;
  const step = preset.steps.find(s => s.label === stepLabel) || preset.steps[0];
  const h0Inp = document.getElementById('boilerH0');
  const gmaxInp = document.getElementById('boilerGmax');
  const hRefInp = document.getElementById('hRefBoiler');
  const gRefInp = document.getElementById('gRefBoiler');
  if (h0Inp) h0Inp.value = String(step.H0);
  if (gmaxInp) gmaxInp.value = String(step.Qmax);
  if (hRefInp) hRefInp.value = String(preset.dpRef);
  if (gRefInp) gRefInp.value = String(preset.qRef);
}

function analyzeSystem(inputs) {
  const flows = computeFlows(inputs);
  // Конвертируем эталонные Δp (кПа) → H_ref (м) и берём G_ref = расчётный расход ветви
  const hRefRadEff = (inputs.dpRefRad > 0) ? (inputs.dpRefRad / KPA_PER_M) : inputs.hRefRad;
  const gRefRadEff = flows.gRad || inputs.gRefRad;
  const hRefUFHPrimEff = (inputs.dpRefUFHPrim > 0) ? (inputs.dpRefUFHPrim / KPA_PER_M) : inputs.hRefUFHPrim;
  const gRefUFHPrimEff = flows.gUFHPrimary || inputs.gRefUFHPrim;

  const kRad = branchK(hRefRadEff, gRefRadEff);
  const kUFHPrim = branchK(hRefUFHPrimEff, gRefUFHPrimEff);

  // Падение на трёхходовом клапане по Kvs (в первичной ветви)
  const hValveUFH = (inputs.kvsUFH > 0 && flows.gUFHPrimary > 0)
    ? ((100 * Math.pow(flows.gUFHPrimary / inputs.kvsUFH, 2)) / KPA_PER_M) // бар->кПа (×100), кПа->м (/9.6)
    : 0;
  const kBoilerInt = branchK(inputs.hRefBoiler, inputs.gRefBoiler);

  const hRadReq = branchHead(kRad, flows.gRad);
  const hUFHPrimReq = branchHead(kUFHPrim, flows.gUFHPrimary) + hValveUFH;
  const hReqBase = Math.max(hRadReq, hUFHPrimReq); // параллельные ветви, требуется больший напор

  const margin = 1 + inputs.headMargin / 100;
  const hExtReqNoSep = hReqBase; // внешний контур (параллель ветвей) при фактических расходах
  // Теоретический предельный расход, который котёл может отдать в сеть с учётом внутренних потерь
  const denom = (inputs.boilerH0 > 0 && inputs.boilerGmax > 0) ? (inputs.boilerH0 / (inputs.boilerGmax * inputs.boilerGmax) + kBoilerInt) : 0;
  let gCapacity = 0;
  if (denom > 0) {
    const nume = inputs.boilerH0 - hExtReqNoSep * margin;
    gCapacity = Math.sqrt(Math.max(0, nume / denom));
    gCapacity = Math.min(gCapacity, inputs.boilerGmax);
  }
  // Фактически требуемый расход из расчётов нагрузки
  const gDemand = flows.gTotal;
  // Отдаваемый в сеть расход
  const gDelivered = Math.min(gDemand, gCapacity);
  const hInternalNoSep = branchHead(kBoilerInt, gDelivered);
  const hPumpAtOperNoSep = pumpHead(inputs.boilerH0, inputs.boilerGmax, gDelivered);
  const hAvailNoSep = Math.max(0, hPumpAtOperNoSep - hInternalNoSep); // остаточный напор на выходе котла
  const okNoAdd = (gDelivered >= gDemand) && (hAvailNoSep >= hExtReqNoSep * margin);

  // Температура обратной линии котла (по текущим действующим расходам)
  const scaleDelivered = gDemand > 0 ? (gDelivered / gDemand) : 0;
  const gRadOper = flows.gRad * scaleDelivered;
  const gUFHPrimOper = flows.gUFHPrimary * scaleDelivered;
  const tRadReturn = inputs.tBoiler - (inputs.dTRad || 0);
  const tUFHReturnLoop = flows.tUFHReturn; // после петель ТП
  const gMix = gRadOper + gUFHPrimOper;
  const tBoilerReturn = gMix > 0 ? ((gRadOper * tRadReturn + gUFHPrimOper * tUFHReturnLoop) / gMix) : inputs.tBoiler;

  // Вариант с насосом на радиаторах и гидроразделителем
  // Блок с гидроразделителем и внешним насосом удалён из UI; здесь оставлено только базовое определение требуемости ГР
  const gOperSep = 0, hInternalSep = 0, hReqPrimarySep = 0, hPumpAtOperSep = 0, hAvailSep = 0, hBoilerWithSep = 0;
  const hRadBranch = branchHead(kRad, flows.gRad);
  const hRadPumpAvail = 0;
  const okWithSep = false;

  // Рекомендации
  let recommendation = '';
  if (okNoAdd) {
    recommendation = 'Остаточного напора встроенного насоса достаточно. Гидравлический разделитель не требуется.';
  } else {
    recommendation = 'Остаточного напора встроенного насоса недостаточно. Рекомендуется установка гидравлического разделителя (и/или увеличение напора/снижение сопротивления системы).';
  }

  return {
    flows, kRad, kUFHPrim, kBoilerInt,
    hRadReq, hUFHPrimReq, hValveUFH, hReqBase,
    gOperNoSep: gDelivered, hInternalNoSep, hExtReqNoSep, hPumpAtOperNoSep, hAvailNoSep, okNoAdd,
    gOperSep, hInternalSep, hReqPrimarySep, hPumpAtOperSep, hAvailSep, hBoilerWithSep,
    hRadBranch, hRadPumpAvail, okWithSep, recommendation, margin,
    tBoilerReturn, tRadReturn
  };
}

// Масштабирование Canvas под HiDPI, рисуем в CSS-пикселях
function scaleCanvasForDPR(canvas, ctx) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// Визуализация: простой Canvas график H(G)
function drawChart(canvas, data) {
  // Особый режим: нижнее окно-схема → только изображение котла справа
  if (canvas && canvas.id === 'scheme') {
    const ctx = canvas.getContext('2d');
    scaleCanvasForDPR(canvas, ctx);
    const rect = canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    ctx.clearRect(0, 0, W, H);

    // Пытаемся загрузить изображение котла из нескольких типичных путей
    if (!window.__kotelImg) {
      const img = new Image();
      const sources = ['images/kotel.png', 'kotel.png', 'assets/kotel.png'];
      let idx = 0;
      const tryNext = () => {
        if (idx >= sources.length) { window.__kotelImg = img; return; }
        img.src = sources[idx++];
      };
      img.onload = () => { window.__kotelImg = img; drawChart(canvas, data); };
      img.onerror = tryNext;
      window.__kotelImg = img;
      tryNext();
    }
    const img = window.__kotelImg;
    // Полноширинный рендер: изображение во всю ширину контейнера, панель тоже во всю ширину
    const pad = 16; const contentW = W - pad * 2; const topPad = 12;
    // Подготовка строк и расчёт высоты панели (ширина = вся ширина схемы)
    const title = `Котёл: ${(BOILERS[data.inputs.boilerType]?.title) || ''}, ступень ${data.inputs.boilerStep}`;
    const linePad = 12; const contentPad = 12; // внутренние отступы
    const maxTextW = Math.max(10, contentW - contentPad * 2);
    function wrapLines(txt, font) {
      ctx.font = font; const words = String(txt).split(' ');
      const lines = []; let line = '';
      words.forEach((word) => {
        const test = line ? line + ' ' + word : word;
        if (ctx.measureText(test).width <= maxTextW) { line = test; }
        else { if (line) lines.push(line); line = word; }
      });
      if (line) lines.push(line);
      return lines;
    }
    const titleLines = wrapLines(title, '14px system-ui, -apple-system, Segoe UI, Roboto');
    const pumpText = `Насос: H0 = ${formatNum(data.inputs.boilerH0)} м; Gmax = ${formatNum(data.inputs.boilerGmax)} м³/ч`;
    const lossText = `Внутренние потери: H_int@${formatNum(data.inputs.gRefBoiler)} ≈ ${formatNum(data.inputs.hRefBoiler)} м; H_ост при рабочем расходе = ${formatNum(data.hAvailNoSep)} м`;
    const pumpLines = wrapLines(pumpText, '12px system-ui, -apple-system, Segoe UI, Roboto');
    const lossLines = wrapLines(lossText, '12px system-ui, -apple-system, Segoe UI, Roboto');
    const panelH = linePad + titleLines.length * 16 + 4 + pumpLines.length * 14 + lossLines.length * 14 + linePad;
    const panelX = pad; const panelW = contentW; const panelY = H - panelH - pad;

    // Рисуем изображение во всю ширину над панелью (с сохранением пропорций)
    const availH = Math.max(0, panelY - topPad - pad);
    if (img && img.complete && img.naturalWidth) {
      const scale = Math.min(contentW / img.naturalWidth, availH / img.naturalHeight);
      const dw = img.naturalWidth * scale; const dh = img.naturalHeight * scale;
      const dx = pad + (contentW - dw) / 2; const dy = topPad + (availH - dh) / 2;
      ctx.drawImage(img, dx, dy, dw, dh);
    } else {
      const boxW = Math.min(360, contentW); const boxH = 120; const dx = pad + (contentW - boxW)/2; const dy = topPad + (availH - boxH)/2;
      ctx.fillStyle = '#141820'; ctx.strokeStyle = '#2b2f3a'; ctx.lineWidth = 1.2; ctx.fillRect(dx, dy, boxW, boxH); ctx.strokeRect(dx, dy, boxW, boxH);
      ctx.fillStyle = '#1e2430'; ctx.font = '16px system-ui, -apple-system, Segoe UI, Roboto'; ctx.fillText('Котёл', dx + 14, dy + 28);
      ctx.fillStyle = '#6b7280'; ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto'; ctx.fillText('Добавьте файл images/kotel.png', dx + 14, dy + 56);
    }

    // Оверлей по центру: температура обратной линии котла
    const overlay = `${formatNum(data.tBoilerReturn)} °C`;
    ctx.save();
    ctx.font = 'bold 18px system-ui, -apple-system, Segoe UI, Roboto';
    const tw = ctx.measureText(overlay).width;
    const bx = (W - (tw + 24)) / 2 - 169; // смещение влево на 169 px
    const by = (H - 36) / 2;
    // скруглённый фон
    const bw = tw + 24; const bh = 36; const r = 10;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.arcTo(bx + bw, by, bx + bw, by + bh, r);
    ctx.arcTo(bx + bw, by + bh, bx, by + bh, r);
    ctx.arcTo(bx, by + bh, bx, by, r);
    ctx.arcTo(bx, by, bx + bw, by, r);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(overlay, bx + 12, by + 24);
    ctx.restore();

    // Оверлей справа: температура подачи котла
    const overlaySupply = `${formatNum(data.inputs.tBoiler)} °C`;
    ctx.save();
    ctx.font = 'bold 18px system-ui, -apple-system, Segoe UI, Roboto';
    const tw2 = ctx.measureText(overlaySupply).width;
    const bx2 = (W - (tw2 + 24)) / 2 + 169 - 600; // ещё на 30 px влево
    const by2 = by; // та же вертикаль
    const bw2 = tw2 + 24; const bh2 = 36; const r2 = 10;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.moveTo(bx2 + r2, by2);
    ctx.arcTo(bx2 + bw2, by2, bx2 + bw2, by2 + bh2, r2);
    ctx.arcTo(bx2 + bw2, by2 + bh2, bx2, by2 + bh2, r2);
    ctx.arcTo(bx2, by2 + bh2, bx2, by2, r2);
    ctx.arcTo(bx2, by2, bx2 + bw2, by2, r2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(overlaySupply, bx2 + 12, by2 + 24);
    ctx.restore();

    // Оверлей по центру: температура подачи радиаторного контура
    const overlayRadSupply = `${formatNum(data.inputs.tBoiler)} °C`;
    ctx.save();
    ctx.font = 'bold 18px system-ui, -apple-system, Segoe UI, Roboto';
    const tw3 = ctx.measureText(overlayRadSupply).width;
    const bx3 = (W - (tw3 + 24)) / 2 - 50; // ещё на 20 px влево
    const by3 = by; // та же вертикаль
    const bw3 = tw3 + 24; const bh3 = 36; const r3 = 10;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.moveTo(bx3 + r3, by3);
    ctx.arcTo(bx3 + bw3, by3, bx3 + bw3, by3 + bh3, r3);
    ctx.arcTo(bx3 + bw3, by3 + bh3, bx3, by3 + bh3, r3);
    ctx.arcTo(bx3, by3 + bh3, bx3, by3, r3);
    ctx.arcTo(bx3, by3, bx3 + bw3, by3, r3);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(overlayRadSupply, bx3 + 12, by3 + 24);
    ctx.restore();

    // Оверлей ниже: температура обратки радиаторов
    const overlayRadReturn = `${formatNum(data.tRadReturn)} °C`;
    ctx.save();
    ctx.font = 'bold 18px system-ui, -apple-system, Segoe UI, Roboto';
    const tw4 = ctx.measureText(overlayRadReturn).width;
    const bx4 = bx3 + 180; // сдвиг вправо на 180 px (на 20 меньше)
    const by4 = by3; // выровнено по высоте с остальными
    const bw4 = tw4 + 24; const bh4 = 36; const r4 = 10;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.moveTo(bx4 + r4, by4);
    ctx.arcTo(bx4 + bw4, by4, bx4 + bw4, by4 + bh4, r4);
    ctx.arcTo(bx4 + bw4, by4 + bh4, bx4, by4 + bh4, r4);
    ctx.arcTo(bx4, by4 + bh4, bx4, by4, r4);
    ctx.arcTo(bx4, by4, bx4 + bw4, by4, r4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(overlayRadReturn, bx4 + 12, by4 + 24);
    ctx.restore();

    // Оверлей: температура подачи ТП после смесителя
    const overlayUFHSupply = `${formatNum(data.inputs.tUFHSupply)} °C`;
    ctx.save();
    ctx.font = 'bold 18px system-ui, -apple-system, Segoe UI, Roboto';
    const tw5 = ctx.measureText(overlayUFHSupply).width;
    const bx5 = (W - (tw5 + 24)) / 2 + 240; // ещё на 30 px влево
    const by5 = by; // одна высота
    const bw5 = tw5 + 24; const bh5 = 36; const r5 = 10;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.moveTo(bx5 + r5, by5);
    ctx.arcTo(bx5 + bw5, by5, bx5 + bw5, by5 + bh5, r5);
    ctx.arcTo(bx5 + bw5, by5 + bh5, bx5, by5 + bh5, r5);
    ctx.arcTo(bx5, by5 + bh5, bx5, by5, r5);
    ctx.arcTo(bx5, by5, bx5 + bw5, by5, r5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(overlayUFHSupply, bx5 + 12, by5 + 24);
    ctx.restore();

    // Оверлей: температура обратки ТП (после петель)
    const overlayUFHReturn = `${formatNum(data.flows.tUFHReturn)} °C`;
    ctx.save();
    ctx.font = 'bold 18px system-ui, -apple-system, Segoe UI, Roboto';
    const tw6 = ctx.measureText(overlayUFHReturn).width;
    const bx6 = (W - (tw6 + 24)) / 2 + 420; // сдвинуто на 30 px вправо
    const by6 = by; // одна высота
    const bw6 = tw6 + 24; const bh6 = 36; const r6 = 10;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.moveTo(bx6 + r6, by6);
    ctx.arcTo(bx6 + bw6, by6, bx6 + bw6, by6 + bh6, r6);
    ctx.arcTo(bx6 + bw6, by6 + bh6, bx6, by6 + bh6, r6);
    ctx.arcTo(bx6, by6 + bh6, bx6, by6, r6);
    ctx.arcTo(bx6, by6, bx6 + bw6, by6, r6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(overlayUFHReturn, bx6 + 12, by6 + 24);
    ctx.restore();

    return;

// Панель (во всю ширину)
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.08)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(panelX, panelY, panelW, panelH); ctx.restore();
    ctx.strokeStyle = '#e5e9f0'; ctx.lineWidth = 1; ctx.strokeRect(panelX, panelY, panelW, panelH);
    let cursorY = panelY + linePad;
    ctx.fillStyle = '#1e2430'; ctx.font = '14px system-ui, -apple-system, Segoe UI, Roboto';
    titleLines.forEach((ln) => { ctx.fillText(ln, panelX + contentPad, cursorY + 14); cursorY += 16; });
    cursorY += 4; ctx.fillStyle = '#6b7280'; ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto';
    pumpLines.forEach((ln) => { ctx.fillText(ln, panelX + contentPad, cursorY + 12); cursorY += 14; });
    lossLines.forEach((ln) => { ctx.fillText(ln, panelX + contentPad, cursorY + 12); cursorY += 14; });
    return;
  }

  const ctx = canvas.getContext('2d');
  scaleCanvasForDPR(canvas, ctx);
  const rect = canvas.getBoundingClientRect();
  const W = rect.width, H = rect.height;
  ctx.clearRect(0, 0, W, H);

  // Новый принцип: «Sankey расходов + индикаторы напора + итог»
  const m = 24;
  ctx.font = '13px system-ui, -apple-system, Segoe UI, Roboto';
  ctx.fillStyle = '#9aa0aa';
  ctx.fillText('Распределение расходов', m, 20);

  const Gt = Math.max(data.flows.gTotal, 0.001);
  const Grad = Math.max(data.flows.gRad, 0);
  const Gufh = Math.max(data.flows.gUFHPrimary, 0);
  const availW = W - m*2 - 260;
  const scale = availW / Gt;

  // Левая полоса (суммарный расход котла)
  const yTop = 60, hBar = 20;
  const xLeft = m + 120;
  const wLeft = Gt * scale;
  pill(xLeft, yTop,  wLeft, hBar, '#7ee0ff');
  ctx.fillText(`G котла = ${formatNum(Gt)} м³/ч`, xLeft, yTop - 6);

  // Правые полосы (ветви)
  const yRad = yTop - 24;
  const yUFH = yTop + 44;
  const xRight = xLeft + 340;
  const wRad = Grad * scale;
  const wUFH = Gufh * scale;
  pill(xRight, yRad, wRad, hBar, '#4f9cff');
  pill(xRight, yUFH, wUFH, hBar, '#4f9cff');
  ctx.fillText(`Радиаторы: ${formatNum(Grad)} м³/ч`, xRight, yRad - 6);
  ctx.fillText(`До смесителя (первичка ТП): ${formatNum(Gufh)} м³/ч`, xRight, yUFH - 6);

  // Соединители (трапеции)
  linkSankey(xLeft + wLeft, yTop + hBar/2, wLeft, xRight, yRad + hBar/2, wRad, hBar, '#5ab6ff');
  linkSankey(xLeft + wLeft, yTop + hBar/2, wLeft, xRight, yUFH + hBar/2, wUFH, hBar, '#5ab6ff');

  // Индикаторы напора
  const yMeters = yUFH + 80; const meterW = Math.min(420, W - m*2 - 40);
  ctx.fillStyle = '#9aa0aa'; ctx.fillText('Напор по ветвям', m, yMeters - 12);
  gauge(m, yMeters, meterW, data.hRadReq * data.margin, data.hAvailNoSep, 'Радиаторы');
  gauge(m, yMeters + 36, meterW, data.hUFHPrimReq * data.margin, data.hAvailNoSep, 'До смесителя (первичка ТП)');
  gauge(m, yMeters + 72, meterW, data.hExtReqNoSep * data.margin, data.hAvailNoSep, 'Итог сети');

  // Итог
  const ok = data.okNoAdd;
  banner(W - m - 260, yMeters - 36, 240, 64, ok ? '#1e5b3e' : '#5b2a2a', ok ? 'Гидроразделитель не требуется' : 'Нужен гидроразделитель');

  // Helpers
  function pill(x, y, w, h, color) {
    ctx.fillStyle = color; ctx.strokeStyle = 'transparent';
    rounded(x, y, w, h, h/2); ctx.fill();
  }
  function rounded(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function linkSankey(x1, y1, w1, x2, y2, w2, h, color) {
    const half = Math.max(h/2, 8);
    ctx.beginPath();
    ctx.moveTo(x1, y1 - half); ctx.bezierCurveTo(x1 + 120, y1 - half, x2 - 120, y2 - half, x2, y2 - half);
    ctx.lineTo(x2, y2 + half); ctx.bezierCurveTo(x2 - 120, y2 + half, x1 + 120, y1 + half, x1, y1 + half);
    ctx.closePath();
    const grad = ctx.createLinearGradient(x1, y1, x2, y2);
    grad.addColorStop(0, color + 'cc'); grad.addColorStop(1, '#a7e9ff');
    ctx.fillStyle = grad; ctx.fill();
  }
  function gauge(x, y, w, need, avail, label) {
    const h = 18; const r = 9;
    // фон
    ctx.fillStyle = '#1b1f2a'; rounded(x, y, w, h, r); ctx.fill();
    // заполнение
    const ratio = need > 0 ? Math.min(avail / need, 1) : 1;
    const gw = Math.max(0, Math.min(w, w * ratio));
    const grad = ctx.createLinearGradient(x, y, x + gw, y);
    const ok = avail >= need;
    grad.addColorStop(0, ok ? '#26b37a' : '#d9534f');
    grad.addColorStop(1, ok ? '#8ce3b3' : '#ff9b9b');
    ctx.fillStyle = grad; rounded(x, y, gw, h, r); ctx.fill();
    ctx.strokeStyle = '#2b2f3a'; rounded(x, y, w, h, r); ctx.stroke();
    ctx.fillStyle = '#9aa0aa'; ctx.fillText(`${label}: треб. ${formatNum(need)} м | ост. ${formatNum(avail)} м`, x, y - 6);
  }
  function banner(x, y, w, h, color, text) {
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 6;
    rounded(x, y, w, h, 10); ctx.fillStyle = color; ctx.fill(); ctx.restore();
    ctx.fillStyle = '#e6e7ea'; ctx.font = '14px system-ui, -apple-system, Segoe UI, Roboto';
    ctx.fillText(text, x + 12, y + h/2 + 4);
  }
}

// Рендер панелей под схемой
function renderSchemePanels(container, data) {
  const bType = BOILERS[data.inputs.boilerType]?.title || '';
  const okBoiler = data.okNoAdd;
  const okRad = data.hAvailNoSep >= data.hRadReq * data.margin;
  const okUFH = data.hAvailNoSep >= data.hUFHPrimReq * data.margin;
  const icon = (ok) => `<span class="status-icon ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✕'}</span>`;
  const num = (v, u = '') => `<span class="num">${formatNum(v)}</span>${u ? `<span class="unit"> ${u}</span>` : ''}`;
  const info = (t) => `<button class="param-info" type="button" data-tip="${t}">i</button>`;
  const html = `
    <div class="scheme-panel ${okBoiler ? 'ok' : 'bad'}">
      <h3>Котёл — расчетные параметры ${icon(okBoiler)}</h3>
      <table class="param-table"><tbody>
        <tr><th>Тип ${info('Модель и класс котла')}</th><td>${bType}</td></tr>
        <tr><th>Ступень насоса ${info('Установленная скорость (I/II/III) встроенного насоса котла')}</th><td>${data.inputs.boilerStep}</td></tr>
        <tr><th>H0 ${info('Напор насоса при нулевом расходе')}</th><td>${num(data.inputs.boilerH0, 'м')}</td></tr>
        <tr><th>Gmax ${info('Расход при нулевом напоре')}</th><td>${num(data.inputs.boilerGmax, 'м³/ч')}</td></tr>
        <tr><th>Рабочий расход ${info('Фактический рабочий расход насоса котла')}</th><td>${num(data.gOperNoSep, 'м³/ч')}</td></tr>
        <tr><th>T обратки котла ${info('Оценка температуры обратной линии котла по текущим расходам ветвей')}</th><td>${num(data.tBoilerReturn, '°C')}</td></tr>
        <tr><th>H_ост при рабочем расходе ${info('Остаточный напор на выходе котла при рабочем расходе')}</th><td>${num(data.hAvailNoSep, 'м')}</td></tr>
        <tr><th>H_потр сети ${info('Требуемый напор внешней сети: радиаторы ∥ первичка ТП')}</th><td>${num(data.hExtReqNoSep, 'м')}</td></tr>
      </tbody></table>
    </div>
    <div class="scheme-panel ${okRad ? 'ok' : 'bad'}">
      <h3>Радиаторный контур ${icon(okRad)}</h3>
      <table class="param-table"><tbody>
        <tr><th>Q ${info('Тепловая нагрузка радиаторов')}</th><td>${num(data.inputs.qRad, 'кВт')}</td></tr>
        <tr><th>ΔT ${info('Разность температур подача-обратка')}</th><td>${num(data.inputs.dTRad, 'K')}</td></tr>
        <tr><th>G ${info('Расчитывается: G = 0.86·Q/ΔT')}</th><td>${num(data.flows.gRad, 'м³/ч')}</td></tr>
        <tr><th>Δp ${info('Эталонный перепад давления ветви (кПа)')}</th><td>${num(data.inputs.dpRefRad, 'кПа')}</td></tr>
        <tr><th>Потр. напор ${info('Необходимый напор на ветви при расчётном расходе')}</th><td>${num(data.hRadReq, 'м')}</td></tr>
      </tbody></table>
    </div>
    <div class="scheme-panel ${okUFH ? 'ok' : 'bad'}">
      <h3>Контур тёплого пола (первичка) ${icon(okUFH)}</h3>
      <table class="param-table"><tbody>
        <tr><th>Q ${info('Тепловая нагрузка ТП')}</th><td>${num(data.inputs.qUFH, 'кВт')}</td></tr>
        <tr><th>ΔT ${info('Разность температур подача-обратка в петлях')}</th><td>${num(data.inputs.dTUFH, 'K')}</td></tr>
        <tr><th>x (подмес) ${info('Доля первичного подмеса из котла')}</th><td><span class="num">${formatNum(data.flows.gUFHPrimary / (data.flows.gUFHLoop || 1), 2)}</span></td></tr>
        <tr><th>G первички ${info('Расход по первичной стороне к смесителю')}</th><td>${num(data.flows.gUFHPrimary, 'м³/ч')}</td></tr>
        <tr><th>Δp до смесителя ${info('Перепад давления на участке до смесителя (кПа)')}</th><td>${num(data.inputs.dpRefUFHPrim, 'кПа')}</td></tr>
        <tr><th>Kvs клапана ${info('Пропускная способность трёхходового клапана')}</th><td>${num(data.inputs.kvsUFH, 'м³/ч')}</td></tr>
        <tr><th>Потери клапана ${info('Потери напора на клапане при данном расходе')}</th><td>${num(data.hValveUFH, 'м')}</td></tr>
      </tbody></table>
    </div>
  `;
  container.innerHTML = html;
}

function formatNum(v, digits = 2) {
  return Number.isFinite(v) ? v.toFixed(digits) : '-';
}

function renderResults(container, model) {
  const { flows } = model;
  const okNoAdd = model.okNoAdd;
  const okWithSep = false;
  const clsNoAdd = okNoAdd ? 'ok' : 'bad';
  const clsWithSep = okWithSep ? 'ok' : 'bad';

  container.innerHTML = `
    <div>
      <div class="muted">Котёл: ${BOILERS[model.inputs.boilerType]?.title || ''}, ступень ${model.inputs.boilerStep} (H0=${formatNum(model.inputs.boilerH0)} м; Gmax=${formatNum(model.inputs.boilerGmax)} м³/ч; H_int@${formatNum(model.inputs.gRefBoiler)}≈${formatNum(model.inputs.hRefBoiler)} м)</div>
      <strong>Расходы:</strong>
      <div>Расход радиаторов = ${formatNum(flows.gRad)} м³/ч; расход ТП (в петлях) = ${formatNum(flows.gUFHLoop)} м³/ч</div>
      <div>Подмес из котла: x = ${formatNum(model.flows.gUFHPrimary / (flows.gUFHLoop || 1), 2)}; первичный расход к смесителю = ${formatNum(flows.gUFHPrimary)} м³/ч</div>
      <div>Необходимый расход (суммарный) = ${formatNum(flows.gTotal)} м³/ч</div>
      <div class="muted">Насос ТП (после трёхходового) обеспечивает расход петель. Котёл обеспечивает только первичный подмес.</div>
      ${model.hValveUFH > 0 ? `<div class="muted">Потери на трёхходовом клапане (Kvs=${formatNum(model.inputs.kvsUFH,2)} м³/ч): ≈ ${formatNum(model.hValveUFH)} м</div>` : ''}
      <div class="muted">Оценка температуры обратной линии котла: Tобр ≈ ${formatNum(model.tBoilerReturn)} °C</div>
    </div>
    <hr />
    <div>
      <strong>Без доп. насоса:</strong>
      <div>Доступный (предельный) расход котла: ≈ ${formatNum(Math.min(model.inputs.boilerGmax, Math.sqrt(Math.max(0, (model.inputs.boilerH0 - model.hExtReqNoSep * model.margin) / ( (model.inputs.boilerH0/(model.inputs.boilerGmax*model.inputs.boilerGmax)) + model.kBoilerInt )))))} м³/ч</div>
      <div>Необходимый расход (рабочий) = ${formatNum(model.gOperNoSep)} м³/ч ${model.gOperNoSep < flows.gTotal ? '(меньше требуемого — ограничено насосом)' : ''}</div>
      <div>Остаточный напор на выходе котла: H_ост = ${formatNum(model.hAvailNoSep)} м</div>
      <div>Потребный напор внешней сети (радиаторы ∥ первичка ТП): H_потр = ${formatNum(model.hExtReqNoSep)} м</div>
      <div>Запас по напору: ${formatNum((model.margin - 1) * 100, 0)} % → H_потр с запасом = ${formatNum(model.hExtReqNoSep * model.margin)} м</div>
      <div>Проверка: H_ост ≥ H_потр(с запасом) → <span class="${clsNoAdd}">${okNoAdd ? 'ОК' : 'НЕ ОК'}</span></div>
    </div>
    <div>
      <strong>Нужен ли гидравлический разделитель:</strong>
      <div><span class="${okNoAdd ? 'ok' : 'bad'}">${okNoAdd ? 'Не требуется' : 'Требуется (встроенного насоса недостаточно)'} </span></div>
    </div>
    <hr />
    <div>
      <strong>Вывод:</strong>
      <div>${model.recommendation}</div>
      <div class="muted">При наличии более одного насоса рекомендуется гидравлическое разделение для развязки контуров.</div>
    </div>
    <div class="alert alert-danger">Внимание: некоторые производители запрещают работу котла напрямую в систему отопления. Смотрите паспорт выбранной модели.</div>
  `;
}

function readInputs() {
  return {
    boilerType: (document.getElementById('boilerType')?.value) || 'condensing_generic',
    boilerStep: (document.getElementById('boilerStep')?.value) || 'II',
    qRad: toNum('qRad'),
    dTRad: toNum('dTRad'),
    qUFH: toNum('qUFH'),
    dTUFH: toNum('dTUFH'),
    tBoiler: toNum('tBoiler'),
    tUFHSupply: toNum('tUFHSupply'),
    hRefRad: toNum('hRefRad'),
    gRefRad: 0,
    hRefUFHPrim: toNum('hRefUFHPrim'),
    gRefUFHPrim: 0,
    dpRefRad: toNum('dpRefRad'),
    dpRefUFHPrim: toNum('dpRefUFHPrim'),
    kvsUFH: toNum('kvsUFH'),
    boilerH0: toNum('boilerH0'),
    boilerGmax: toNum('boilerGmax'),
    boilerGmin: toNum('boilerGmin'),
    hRefBoiler: toNum('hRefBoiler'),
    gRefBoiler: toNum('gRefBoiler'),
    headMargin: toNum('headMargin'),
    sepLoss: 0
  };
}

function setChip(id, state, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('ok', 'bad', 'warn');
  if (state) el.classList.add(state);
  el.textContent = text;
}

function calcAndRender() {
  const inputs = readInputs();
  const analysis = analyzeSystem(inputs);
  analysis.inputs = inputs;

  const resultsEl = document.getElementById('results');
  renderResults(resultsEl, analysis);

  const canvas = document.getElementById('chart');
  if (canvas) drawChart(canvas, analysis);
  const scheme = document.getElementById('scheme');
  if (scheme) drawChart(scheme, analysis);
  const schemePanels = document.getElementById('scheme-panels');
  if (schemePanels) renderSchemePanels(schemePanels, analysis);

   // Обновление статусов карточек
  setChip('status-boiler', analysis.okNoAdd ? 'ok' : 'bad', analysis.okNoAdd ? 'Насос котла: ОК' : 'Нужен больший напор');

  const okRadBranch = analysis.hAvailNoSep >= analysis.hRadReq * analysis.margin;
  setChip('status-rad', okRadBranch ? 'ok' : 'bad', okRadBranch ? 'Радиаторы: ОК' : 'Радиаторы: не хватает напора');

  const okUFHPrim = analysis.hAvailNoSep >= analysis.hUFHPrimReq * analysis.margin;
  setChip('status-ufh', okUFHPrim ? 'ok' : 'bad', okUFHPrim ? 'ТП: первичка ОК' : 'ТП: не хватает напора');
}

function resetForm() {
  document.querySelectorAll('input').forEach((el) => {
    if (el.type === 'number' && el.defaultValue !== undefined) {
      el.value = el.defaultValue;
    }
  });
  calcAndRender();
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('resetBtn').addEventListener('click', resetForm);
  const boilerCard = document.getElementById('card-boiler');
  const boilerAdvBtn = document.getElementById('boilerAdvBtn');
  // заполняем селекторы котла
  const typeSel = document.getElementById('boilerType');
  const stepSel = document.getElementById('boilerStep');
  if (typeSel && stepSel) {
    // options for types
    typeSel.innerHTML = Object.keys(BOILERS).map(k => `<option value="${k}">${BOILERS[k].title}</option>`).join('');
    // default type
    typeSel.value = 'condensing_generic';
    const fillSteps = () => {
      const t = BOILERS[typeSel.value];
      stepSel.innerHTML = t.steps.map(s => `<option value="${s.label}">${s.label}</option>`).join('');
      stepSel.value = 'II';
      applyBoilerPreset(typeSel.value, stepSel.value);
    };
    const onChange = () => {
      applyBoilerPreset(typeSel.value, stepSel.value);
      calcAndRender();
    };
    fillSteps();
    typeSel.addEventListener('change', () => { fillSteps(); calcAndRender(); });
    stepSel.addEventListener('change', onChange);
  }
  if (boilerCard && boilerAdvBtn) {
    boilerAdvBtn.addEventListener('click', () => {
      boilerCard.classList.toggle('adv-enabled');
    });
  }
  // Popover: показываем текст .hint текущей карточки по клику на значок
  function openPopoverNear(el, html) {
    document.querySelectorAll('.popover').forEach(p => p.remove());
    const pop = document.createElement('div');
    pop.className = 'popover';
    pop.innerHTML = html;
    document.body.appendChild(pop);
    const r = el.getBoundingClientRect();
    const top = r.bottom + 8;
    const left = Math.min(window.innerWidth - pop.offsetWidth - 12, Math.max(12, r.left - 40));
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
    const close = () => { pop.remove(); document.removeEventListener('click', onDoc, true); };
    const onDoc = (ev) => { if (!pop.contains(ev.target)) close(); };
    setTimeout(() => document.addEventListener('click', onDoc, true), 0);
  }
  document.querySelectorAll('.card-entity .info-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = btn.closest('.card-entity');
      const hint = card?.querySelector('.hint');
      if (!hint) return;
      openPopoverNear(btn, hint.innerHTML);
    });
  });
  // Tooltips для параметров
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.param-info');
    if (!btn) return;
    e.stopPropagation();
    const text = btn.getAttribute('data-tip') || '';
    openPopoverNear(btn, text);
  });

  // Tabs switching
  const tabButtons = document.querySelectorAll('.tab-btn');
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.getAttribute('data-tab');
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      const panel = document.getElementById(`tab-${target}`);
      if (panel) panel.classList.add('active');
      if (target === 'two-circuits') calcAndRender();
    });
  });
  // Live-обновление для наглядности
  document.querySelectorAll('input').forEach((el) => {
    el.addEventListener('change', calcAndRender);
    el.addEventListener('input', () => {
      // throttled update
      clearTimeout(window.__upd);
      window.__upd = setTimeout(calcAndRender, 150);
    });
  });
  calcAndRender();
});

// Быстрый расчёт Δp радиаторного контура (приближённо)
function openQuickModal() {
  const modal = document.getElementById('quickModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  // Синхронизируем видимость полей и значения по умолчанию
  if (typeof quickSyncVisibility === 'function') quickSyncVisibility();
  quickRecalc();
}
function closeQuickModal() {
  const modal = document.getElementById('quickModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}
function quickGetInputs() {
  const sys = (document.querySelector('input[name="radSys"]:checked')?.value) || 'tee';
  const numRad = Number(document.getElementById('qcNumRad')?.value || 0);
  const len = Number(document.getElementById('qcLen')?.value || 0);
  const diamSel = document.getElementById('qcDiam')?.value || '20';
  const diam = (diamSel === 'custom') ? Number(document.getElementById('qcDiamCustom')?.value || 20) : Number(diamSel);
  const qSingle = Number(document.getElementById('qcQSingle')?.value || 0);
  const qSum = Number(document.getElementById('qcQSum')?.value || 0);
  // Константы по умолчанию
  const dpRad = 1.0; // кПа на радиатор (с клапаном)
  const dpColl = 2.0; // кПа на коллектор (грубая оценка)
  return { sys, numRad, len, diam, qSingle, qSum, dpRad, dpColl };
}
function quickSpecificLossPaPerM(diam, g) {
  // базовые справочные точки (очень грубо)
  const ref = { 12: { g: 0.12, pa: 450 }, 16: { g: 0.20, pa: 200 }, 20: { g: 0.40, pa: 80 }, 25: { g: 0.80, pa: 35 } };
  const r = ref[diam] || ref[20];
  const k = r.pa / (r.g * r.g);
  return k * g * g; // Па/м
}
function quickRecalc() {
  const modal = document.getElementById('quickModal');
  if (!modal) return;
  const { sys, numRad, len, diam, qSingle, qSum, dpRad, dpColl } = quickGetInputs();
  // исходный суммарный расход из основных полей
  const qRad = Number(document.getElementById('qRad')?.value || 0);
  const dTRad = Number(document.getElementById('dTRad')?.value || 20);
  const gRad = (qRad > 0 && dTRad > 0) ? (0.86 * qRad / dTRad) : 0;

  let gBranch = 0;
  if (sys === 'tee') {
    if (qSum > 0 && dTRad > 0) gBranch = 0.86 * qSum / dTRad; else gBranch = gRad; // fallback
  } else {
    if (qSingle > 0 && dTRad > 0) gBranch = 0.86 * qSingle / dTRad; else gBranch = (numRad > 0) ? gRad / numRad : gRad * 0.2;
  }
  const paPerM = quickSpecificLossPaPerM(diam, gBranch);
  // местные потери: фитинги и арматура
  let local_kPa;
  if (sys === 'tee') {
    const perDevice = Math.max(0, dpRad || 1.0) + 0.5;
    local_kPa = Math.max(0, numRad) * perDevice;
  } else {
    local_kPa = Math.max(0, dpColl || 2.0) + Math.max(0, dpRad || 1.0);
  }
  const pipe_kPa = (paPerM * Math.max(0, len)) / 1000;
  const sum_kPa = pipe_kPa * 1.2 + local_kPa; // +20% на прочие местные

  const out = document.getElementById('qcResult');
  if (out) {
    out.innerHTML = `
      <div>Тип: <strong>${sys === 'tee' ? 'Тройниковая' : 'Коллекторная'}</strong></div>
      <div>Оценочный расход ветки: <strong>${formatNum(gBranch)} м³/ч</strong></div>
      <div>Удельные потери: ~${formatNum(paPerM)} Па/м</div>
      <div>Потери в трубах: ~${formatNum(pipe_kPa)} кПа</div>
      <div>Местные потери: ~${formatNum(local_kPa)} кПа ${sys==='manifold' ? '(коллектор + радиатор)' : '(радиаторы на ветке)'} </div>
      <div><strong>Итого Δp ≈ ${formatNum(sum_kPa)} кПа</strong></div>
      <div class="muted">ПРИМЕЧАНИЕ: оценка грубая, применяйте запас.</div>
    `;
  }
  return sum_kPa;
}
function quickApply() {
  const val = quickRecalc();
  const field = document.getElementById('dpRefRad');
  if (field && Number.isFinite(val)) {
    field.value = String(val.toFixed(2));
    // уведомим общую логику об изменении
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }
  closeQuickModal();
  calcAndRender();
}
function attachQuickModalHandlers() {
  const openBtn = document.getElementById('radQuickBtn');
  const modal = document.getElementById('quickModal');
  if (!modal || !openBtn) return;
  openBtn.addEventListener('click', openQuickModal);
  document.getElementById('quickClose')?.addEventListener('click', closeQuickModal);
  document.getElementById('qcCancel')?.addEventListener('click', closeQuickModal);
  modal.querySelector('.modal-backdrop')?.addEventListener('click', closeQuickModal);
  // показываем/скрываем поля в зависимости от выбора
  function quickSyncVisibility() {
    const sys = (document.querySelector('input[name="radSys"]:checked')?.value) || 'tee';
    const onlyTee = modal.querySelectorAll('.only-tee');
    onlyTee.forEach(el => el.toggleAttribute('hidden', sys !== 'tee'));
    const onlyMan = modal.querySelectorAll('.only-manifold');
    onlyMan.forEach(el => el.toggleAttribute('hidden', sys !== 'manifold'));
    // диаметр по умолчанию: тройниковая → 16 мм; коллекторная → 12 мм
    const diamEl = document.getElementById('qcDiam');
    if (diamEl && !diamEl.__userChanged) {
      diamEl.value = (sys === 'tee') ? '16' : '12';
    }
    const diamSel = document.getElementById('qcDiam')?.value || '20';
    const onlyCustom = modal.querySelectorAll('.only-custom');
    onlyCustom.forEach(el => el.toggleAttribute('hidden', diamSel !== 'custom'));
  }
  // live recalc
  ['qcNumRad','qcLen','qcDiam','qcDiamCustom','qcQSingle','qcQSum']
    .forEach(id => document.getElementById(id)?.addEventListener('input', () => { quickSyncVisibility(); quickRecalc(); }));
  modal.querySelectorAll('input[name="radSys"]').forEach(el => el.addEventListener('change', () => { quickSyncVisibility(); quickRecalc(); }));
  // пользовательские изменения диаметра
  const diamEl = document.getElementById('qcDiam');
  diamEl?.addEventListener('change', () => { diamEl.__userChanged = true; });
  const diamCustomEl = document.getElementById('qcDiamCustom');
  diamCustomEl?.addEventListener('input', () => { const sel = document.getElementById('qcDiam'); if (sel) sel.__userChanged = true; });
  // кнопка применить
  document.getElementById('qcApply')?.addEventListener('click', quickApply);
  // подстраховка делегированием
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.id === 'qcApply') {
      e.preventDefault();
      quickApply();
    }
  });
  // клики по «красивым» выборам с иконками — переключают radio и состояние
  function bindChoiceGroup(wrapperId, radioName) {
    const wrap = document.getElementById(wrapperId);
    if (!wrap) return;
    wrap.querySelectorAll('.choice').forEach((label) => {
      label.addEventListener('click', () => {
        const input = label.querySelector('input[type="radio"]');
        if (input) input.checked = true;
        wrap.querySelectorAll('.choice').forEach(l => l.classList.remove('active'));
        label.classList.add('active');
        quickSyncVisibility(); quickRecalc();
      });
    });
  }
  bindChoiceGroup('sysChoices', 'radSys');
  // modeChoices удалён (всегда упрощённый режим)
}

// инициализация модалки после загрузки
window.addEventListener('DOMContentLoaded', attachQuickModalHandlers);


