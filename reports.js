'use strict';
// Отчёты периода: сборка данных, Excel и PDF. Файлы возвращаются как File, отдача — в app.js.

const PDF_MARGIN = 14;
const PDF_WIDTH = 210 - PDF_MARGIN * 2;

// Библиотеки весят больше самого приложения, поэтому грузятся при первом отчёте, а не при запуске.
const vendorScripts = new Map();

function loadVendor(src) {
  if (!vendorScripts.has(src)) {
    vendorScripts.set(src, new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => {
        vendorScripts.delete(src);
        reject(new Error(`Не загрузился ${src}`));
      };
      document.head.appendChild(script);
    }));
  }
  return vendorScripts.get(src);
}

async function buildReport(period) {
  const [summary, userName, org] = await Promise.all([
    periodSummary(period),
    getSetting('userName'),
    getSetting('org'),
  ]);
  const purchases = await withSuppliers(summary.purchases);
  const active = purchases.filter(p => p.status === 'active');
  const storno = purchases.filter(p => p.status === 'storno');

  const end = period.closed || nowLocal().slice(0, 10);
  return {
    ...summary,
    repayments: await withPurchases(summary.repayments),
    returns: summary.returns.slice().sort((a, b) => a.dt.localeCompare(b.dt)),
    // Справочно: долг поставщикам по всем периодам на последний день отчёта. В остаток не входит.
    debtEnd: sumLeft(await getDebts(end)),
    period,
    org: org || '',
    userName: userName || '',
    purchases,
    active,
    storno,
    stornoSum: sumAmounts(storno),
    noDocList: active.filter(p => p.docType === 'none'),
    services: sumAmounts(active.filter(p => p.type === 'service')),
    withoutItems: active.filter(p => !p.items.length),
    docsCount: active.filter(p => p.docType !== 'none').length,
    end,
    fileBase: `${period.number}_${period.opened}_${end}`,
  };
}

const reportTitle = p => (p.type === 'service' ? `Услуга: ${p.title}` : p.title);

/* Статистика для экрана «Отчёт». В файлы для бухгалтерии не попадает. */

const STAT_TOP = 5;
const STAT_DAILY_LIMIT = 31;
const STAT_WEEKLY_LIMIT = 182;
const STAT_MONTHLY_LIMIT = 930;

const dateOf = iso => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
};
const daysBetween = (from, to) => Math.round((dateOf(to) - dateOf(from)) / 864e5);

function isoDate(d) {
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

function isoPlusDays(iso, days) {
  const d = dateOf(iso);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

// Столбцов не больше 31, иначе на телефоне их не прочитать: длинный диапазон укрупняется.
function spendingBuckets(active, from, to) {
  const days = daysBetween(from, to) + 1;
  const step = days <= STAT_DAILY_LIMIT ? 1 : days <= STAT_WEEKLY_LIMIT ? 7 : days <= STAT_MONTHLY_LIMIT ? 30 : 365;
  const buckets = Array.from({ length: Math.ceil(days / step) }, (_, i) => {
    const start = isoPlusDays(from, i * step);
    const end = isoPlusDays(start, step - 1);
    const label = step === 1 ? dShort(start) : step === 365 ? `${dFull(start)}–${dFull(end)}` : `${dShort(start)}–${dShort(end)}`;
    return { label, from: start, to: end < to ? end : to, sum: 0 };
  });
  active.forEach(p => {
    const i = Math.floor(daysBetween(from, p.dt) / step);
    buckets[Math.min(Math.max(i, 0), buckets.length - 1)].sum += p.amount;
  });
  return { buckets, unit: { 1: 'дням', 7: 'неделям', 30: 'месяцам', 365: 'годам' }[step] };
}

// Первые пять по сумме, остальное одной строкой: ряды длиннее на телефоне не читаются.
function rankTop(pairs) {
  const totals = new Map();
  pairs.forEach(([name, amount]) => totals.set(name, (totals.get(name) || 0) + amount));
  const sorted = [...totals].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);
  const top = sorted.slice(0, STAT_TOP);
  const rest = sumAmounts(sorted.slice(STAT_TOP));
  return rest ? [...top, { name: 'Прочие', amount: rest, other: true }] : top;
}

function reportStats(active, from, to) {
  const spent = sumAmounts(active);
  const services = sumAmounts(active.filter(p => p.type === 'service'));
  return {
    ...spendingBuckets(active, from, to),
    spent,
    services,
    goodsSum: spent - services,
    count: active.length,
    top: {
      suppliers: rankTop(active.map(p => [p.supplier, p.amount])),
      bazaars: rankTop(active.filter(p => p.type !== 'service').map(p => [p.place || 'Не указан', p.amount])),
      goods: rankTop(active.flatMap(p => (p.items.length ? p.items.map(i => [i.name, i.sum]) : [[p.title || 'Без названия', p.amount]]))),
    },
  };
}

// Закупки с именами поставщиков, нужными отчёту и статистике.
async function withSuppliers(purchases) {
  const suppliers = new Map((await db.suppliers.toArray()).map(s => [s.id, s]));
  return purchases.slice().sort((a, b) => a.id - b.id).map(p => {
    const supplier = suppliers.get(p.supplierId);
    return { ...p, title: purchaseTitle(p), supplier: supplier.name, phone: supplier.phone };
  });
}

// Погашения с закупкой, за которую отдан долг: она может быть из прошлого периода.
async function withPurchases(repayments) {
  const ids = [...new Set(repayments.map(r => r.purchaseId))];
  const purchases = new Map((await withSuppliers((await db.purchases.bulkGet(ids)).filter(Boolean))).map(p => [p.id, p]));
  const periods = new Map((await db.periods.toArray()).map(p => [p.id, p.number]));
  return repayments.slice().sort((a, b) => a.dt.localeCompare(b.dt) || a.id - b.id).map(r => {
    const purchase = purchases.get(r.purchaseId);
    return { ...r, purchase, periodNumber: purchase ? periods.get(purchase.periodId) : '' };
  });
}

// Как в файле назван долг, за который заплатили: номер закупки, её дата и период, если он другой.
const repaymentSubject = (r, periodId) => (r.purchase
  ? `№${pad3(r.purchase.no)} от ${dFull(r.purchase.dt)}${r.purchase.periodId !== periodId ? `, ${r.periodNumber}` : ''}: ${reportTitle(r.purchase)}`
  : 'Закупка убрана в архив');

// Строки расчёта одинаковы в приложении, Excel и PDF. key — что показать по нажатию в приложении.
// Без долгов расчёт выглядит как раньше: закупки и есть израсходованное.
function settlementRows(r) {
  const n = `${r.count} ${plural(r.count, 'закупка', 'закупки', 'закупок')}`;
  const withDebts = r.onDebt || r.repaid;
  return [
    { key: 'issued', label: 'Выдано авансом', value: r.issued },
    { key: 'bought', label: withDebts ? `Закупки (${n})` : `Израсходовано (${n})`, value: r.bought },
    { key: 'services', label: 'в т.ч. услуги', value: r.services, sub: true },
    { key: 'noDoc', label: 'в т.ч. без документов', value: r.noDoc, sub: true, cls: 'warn' },
    ...(r.onDebt ? [{ key: 'onDebt', label: 'в т.ч. взято в долг, не из аванса', value: r.onDebt, sub: true, cls: 'warn' }] : []),
    ...(r.repaid ? [{ key: 'repaid', label: `Погашение долгов (${r.repayments.length})`, value: r.repaid }] : []),
    ...(withDebts ? [{ key: 'spent', label: 'Израсходовано из аванса', value: r.spent }] : []),
    { key: 'storno', label: 'Сторно, не учитывается', value: r.stornoSum, sub: true, cls: 'muted' },
    { key: 'returned', label: 'Возвращено в кассу', value: r.returned },
  ];
}

const debtEndLabel = r => `Долг поставщикам на ${dFull(r.end)}, вне аванса`;

// Статистика за даты идёт через все отчётные периоды.
async function purchasesBetween(from, to) {
  const list = await db.purchases.where('dt').between(from, `${to}T99`, true, true).toArray();
  return withSuppliers(list.filter(p => p.status === 'active'));
}

const balanceLabel = r => (r.balance < 0 ? 'Перерасход' : 'Остаток');

/* Excel */

// Сумма в ячейке — число, чтобы бухгалтерия могла считать. Тыйыны в сомы переводятся только здесь.
const xlsMoney = tyiyn => ({ v: tyiyn / 100, t: 'n', z: '#,##0.00' });

function addSheet(wb, name, rows, widths) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = widths.map(wch => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws, name);
}

async function reportXlsx(r) {
  await loadVendor('vendor/xlsx.mini.min.js');
  const wb = XLSX.utils.book_new();
  const date = p => dFull(p.dt);

  addSheet(wb, 'Сводка', [
    ['Организация', r.org],
    ['Подотчётное лицо', r.userName],
    ['Период', r.period.number],
    ['Даты', `${dFull(r.period.opened)} — ${dFull(r.end)}`],
    ['Статус', r.period.status === 'closed' ? 'Закрыт' : 'Открыт'],
    ...(r.period.revision ? [['Редакция', r.period.revision]] : []),
    [],
    ...settlementRows(r).map(row => [row.label, xlsMoney(row.value)]),
    [balanceLabel(r), xlsMoney(Math.abs(r.balance))],
    ...(r.debtEnd ? [[debtEndLabel(r), xlsMoney(r.debtEnd)]] : []),
    [],
    ['Выдачи'],
    ...r.advances.map(a => [`${dFull(a.date)}, ${ADV_METHOD[a.method]}, ${a.by}`, xlsMoney(a.amount)]),
    ...(r.returns.length ? [[], ['Возвраты в кассу'], ...r.returns.map(x => [`${dFull(x.dt)}, ${PAY[x.method]}, ${x.to}`, xlsMoney(x.amount)])] : []),
  ], [40, 40]);

  addSheet(wb, 'Реестр', [
    ['№', 'Дата', 'Тип', 'Товар / услуга', 'Документ', 'Оплата', 'Сумма', 'В долг', 'Комментарий'],
    ...r.active.map(p => [pad3(p.no), date(p), p.type === 'service' ? 'Услуга' : 'Товар', p.title, DOC[p.docType], PAY[p.payment], xlsMoney(p.amount), debtOf(p) ? xlsMoney(debtOf(p)) : '', p.comment]),
    ['Итого', '', '', '', '', '', xlsMoney(r.bought), r.onDebt ? xlsMoney(r.onDebt) : ''],
  ], [7, 11, 8, 40, 15, 11, 14, 14, 30]);

  addSheet(wb, 'Позиции', [
    ['№ закупки', 'Дата', 'Наименование', 'Ед.', 'Кол-во', 'Цена', 'Сумма'],
    ...r.active.flatMap(p => (p.items.length
      ? p.items.map(i => [pad3(p.no), date(p), i.name, i.unit, i.qty, xlsMoney(i.price), xlsMoney(i.sum)])
      : [[pad3(p.no), date(p), `${p.title}: позиции не внесены`, '', '', '', xlsMoney(p.amount)]])),
    ['Итого', '', '', '', '', '', xlsMoney(r.bought)],
  ], [10, 11, 42, 7, 9, 13, 14]);

  if (r.repayments.length) {
    addSheet(wb, 'Погашения', [
      ['Дата', 'За что', 'Способ', 'Сумма', 'Комментарий'],
      ...r.repayments.map(x => [dFull(x.dt), repaymentSubject(x, r.period.id), PAY[x.method], xlsMoney(x.amount), x.comment]),
      ['Итого', '', '', xlsMoney(r.repaid)],
    ], [11, 50, 11, 14, 30]);
  }

  addSheet(wb, 'Сторно', [
    ['№', 'Дата', 'Товар / услуга', 'Сумма', 'Причина'],
    ...r.storno.map(p => [pad3(p.no), date(p), p.title, xlsMoney(p.amount), p.stornoReason]),
  ], [7, 11, 34, 14, 40]);

  const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new File([data], `Подотчёт_${r.fileBase}.xlsx`, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/* PDF */

const PDF_FONTS = [['vendor/fonts/IBMPlexSans-Regular.ttf', 'normal'], ['vendor/fonts/IBMPlexSans-SemiBold.ttf', 'bold']];
let pdfFontsBase64 = null;

async function loadPdfFonts() {
  if (pdfFontsBase64) return pdfFontsBase64;
  pdfFontsBase64 = await Promise.all(PDF_FONTS.map(async ([url]) => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  }));
  return pdfFontsBase64;
}

async function newPdf(title) {
  await loadVendor('vendor/jspdf.umd.min.js');
  await loadVendor('vendor/jspdf.plugin.autotable.min.js');
  const fonts = await loadPdfFonts();
  const doc = new window.jspdf.jsPDF({ format: 'a4', unit: 'mm' });
  PDF_FONTS.forEach(([url, style], i) => {
    const file = url.split('/').pop();
    doc.addFileToVFS(file, fonts[i]);
    doc.addFont(file, 'Plex', style);
  });
  doc.setFont('Plex', 'normal');
  doc.setProperties({ title });
  return doc;
}

function pdfTable(doc, options) {
  doc.autoTable({
    theme: 'plain',
    margin: { left: PDF_MARGIN, right: PDF_MARGIN, top: PDF_MARGIN, bottom: 16 },
    styles: { font: 'Plex', fontSize: 9, cellPadding: { top: 1, bottom: 1, left: 1.2, right: 1.2 }, lineColor: [190, 197, 205], lineWidth: { bottom: 0.1 }, textColor: [22, 32, 42] },
    headStyles: { fontStyle: 'bold', fontSize: 8, lineWidth: { bottom: 0.3 } },
    footStyles: { fontStyle: 'bold' },
    rowPageBreak: 'avoid',
    ...options,
  });
  return doc.lastAutoTable.finalY;
}

// Заголовок раздела не должен оставаться один внизу страницы.
function pdfHeading(doc, y, text, needed = 24) {
  let top = y + 7;
  if (top + needed > 297 - 16) {
    doc.addPage();
    top = PDF_MARGIN + 4;
  }
  doc.setFont('Plex', 'bold');
  doc.setFontSize(11);
  doc.text(text, PDF_MARGIN, top);
  doc.setFont('Plex', 'normal');
  return top + 2;
}

function pdfFooter(doc, label) {
  const pages = doc.getNumberOfPages();
  doc.setFontSize(8);
  doc.setTextColor(90, 103, 116);
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.text(`${label} · стр. ${i} из ${pages}`, 210 - PDF_MARGIN, 297 - 9, { align: 'right' });
  }
}

function pdfRegistryRows(r) {
  const right = { halign: 'right' };
  return r.active.flatMap(p => {
    const head = [pad3(p.no), dFull(p.dt), reportTitle(p), DOC[p.docType], PAY[p.payment], money(p.amount)]
      .map((content, i) => ({ content, styles: { fontStyle: 'bold', ...(i === 5 ? right : {}) } }));
    const rows = p.items.map(i => [
      '',
      { content: i.name, colSpan: 2 },
      { content: `${String(i.qty).replace('.', ',')} ${i.unit} × ${money(i.price)}`, colSpan: 2, styles: right },
      { content: money(i.sum), styles: right },
    ]);
    if (!p.items.length) rows.push(['', { content: 'Позиции не внесены', colSpan: 5, styles: { textColor: [90, 103, 116] } }]);
    if (debtOf(p)) rows.push(['', { content: `В долг: оплачено сразу ${money(p.paidNow)}, долг ${money(debtOf(p))}`, colSpan: 5, styles: { textColor: [90, 103, 116] } }]);
    return [head, ...rows];
  });
}

async function reportPdf(r) {
  const title = `Авансовый отчёт ${r.period.number}`;
  const doc = await newPdf(title);
  const right = { halign: 'right' };

  doc.setFont('Plex', 'bold');
  doc.setFontSize(15);
  doc.text('Авансовый отчёт', PDF_MARGIN, 20);
  doc.setFontSize(10);
  if (r.period.revision) doc.text(`Редакция ${r.period.revision}`, 210 - PDF_MARGIN, 20, { align: 'right' });
  doc.setFont('Plex', 'normal');
  [
    `Организация: ${r.org}`,
    `Подотчётное лицо: ${r.userName || '____________________'}`,
    `Период: ${r.period.number}, ${dFull(r.period.opened)} — ${dFull(r.end)}${r.period.status === 'closed' ? '' : ' (не закрыт)'}`,
  ].forEach((line, i) => doc.text(line, PDF_MARGIN, 27 + i * 5));

  let y = pdfHeading(doc, 39, 'Выдачи');
  y = pdfTable(doc, {
    startY: y,
    head: [['Дата', 'Способ', 'Кто выдал', { content: 'Сумма', styles: right }]],
    body: r.advances.map(a => [dFull(a.date), ADV_METHOD[a.method], a.by, { content: money(a.amount), styles: right }]),
    foot: [[{ content: 'Итого выдано', colSpan: 3 }, { content: money(r.issued), styles: right }]],
    showFoot: 'lastPage',
  });

  if (r.returns.length) {
    y = pdfHeading(doc, y, 'Возвраты в кассу');
    y = pdfTable(doc, {
      startY: y,
      head: [['Дата', 'Способ', 'Кому', { content: 'Сумма', styles: right }]],
      body: r.returns.map(x => [dFull(x.dt), PAY[x.method], x.to, { content: money(x.amount), styles: right }]),
      foot: [[{ content: 'Итого возвращено', colSpan: 3 }, { content: money(r.returned), styles: right }]],
      showFoot: 'lastPage',
    });
  }

  y = pdfHeading(doc, y, 'Реестр закупок');
  y = pdfTable(doc, {
    startY: y,
    head: [['№', 'Дата', 'Товар / услуга', 'Документ', 'Оплата', { content: 'Сумма', styles: right }]],
    body: pdfRegistryRows(r),
    foot: [[{ content: 'Итого без сторно', colSpan: 5 }, { content: money(r.bought), styles: right }]],
    showFoot: 'lastPage',
    columnStyles: { 0: { cellWidth: 10 }, 1: { cellWidth: 20 }, 3: { cellWidth: 26 }, 4: { cellWidth: 19 }, 5: { cellWidth: 24 } },
  });

  if (r.repayments.length) {
    y = pdfHeading(doc, y, 'Погашение долгов из аванса');
    y = pdfTable(doc, {
      startY: y,
      head: [['Дата', 'За что', 'Способ', { content: 'Сумма', styles: right }]],
      body: r.repayments.map(x => [dFull(x.dt), repaymentSubject(x, r.period.id), PAY[x.method], { content: money(x.amount), styles: right }]),
      foot: [[{ content: 'Итого погашено', colSpan: 3 }, { content: money(r.repaid), styles: right }]],
      showFoot: 'lastPage',
      columnStyles: { 0: { cellWidth: 20 }, 2: { cellWidth: 19 }, 3: { cellWidth: 24 } },
    });
  }

  if (r.noDocList.length) {
    y = pdfHeading(doc, y, 'Без документов');
    y = pdfTable(doc, {
      startY: y,
      head: [['№', 'Дата', 'Товар / услуга', { content: 'Сумма', styles: right }]],
      body: r.noDocList.map(p => [pad3(p.no), dFull(p.dt), reportTitle(p), { content: money(p.amount), styles: right }]),
      foot: [[{ content: 'Итого без документов', colSpan: 3 }, { content: money(r.noDoc), styles: right }]],
      showFoot: 'lastPage',
      columnStyles: { 0: { cellWidth: 10 }, 1: { cellWidth: 20 } },
    });
  }

  if (r.storno.length) {
    y = pdfHeading(doc, y, 'Сторно (в сумму не входит)');
    y = pdfTable(doc, {
      startY: y,
      head: [['№', 'Дата', 'Товар / услуга', 'Причина', { content: 'Сумма', styles: right }]],
      body: r.storno.map(p => [pad3(p.no), dFull(p.dt), reportTitle(p), p.stornoReason || '', { content: money(p.amount), styles: right }]),
      columnStyles: { 0: { cellWidth: 10 }, 1: { cellWidth: 20 }, 4: { cellWidth: 24 } },
    });
  }

  y = pdfHeading(doc, y, 'Расчёт', 50);
  y = pdfTable(doc, {
    startY: y,
    body: [
      ...settlementRows(r).filter(row => row.key !== 'storno' && row.key !== 'noDoc').map(row => [row.label, { content: money(row.value), styles: right }]),
      [{ content: balanceLabel(r), styles: { fontStyle: 'bold' } }, { content: `${money(Math.abs(r.balance))} сом`, styles: { ...right, fontStyle: 'bold' } }],
      ...(r.debtEnd ? [[debtEndLabel(r), { content: money(r.debtEnd), styles: right }]] : []),
    ],
  });

  const signatures = [['Подотчётное лицо', r.userName], ['Бухгалтер', ''], ['Руководитель', '']];
  if (y + 14 + signatures.length * 12 > 297 - 16) {
    doc.addPage();
    y = PDF_MARGIN;
  }
  doc.setFontSize(10);
  signatures.forEach(([role, name], i) => {
    const line = y + 16 + i * 12;
    doc.text(role, PDF_MARGIN, line);
    doc.setDrawColor(90, 103, 116);
    doc.line(62, line, 122, line);
    if (name) doc.text(name, 126, line);
  });

  pdfFooter(doc, `${r.period.number}${r.period.revision ? `, редакция ${r.period.revision}` : ''}`);
  return new File([doc.output('arraybuffer')], `Авансовый_отчёт_${r.fileBase}.pdf`, { type: 'application/pdf' });
}

// Приложение: фото документов, одно на страницу. Фото товара в PDF не входят. null, если фото нет.
async function photosPdf(r) {
  const photos = await db.photos.where('purchaseId').anyOf(r.active.map(p => p.id)).filter(p => p.kind === 'receipt').toArray();
  const byPurchase = new Map();
  photos.forEach(photo => byPurchase.set(photo.purchaseId, [...(byPurchase.get(photo.purchaseId) || []), photo]));
  const shots = r.active.flatMap(purchase => (byPurchase.get(purchase.id) || []).map(photo => ({ purchase, blob: photo.blob })));
  if (!shots.length) return null;

  const doc = await newPdf(`Фото документов ${r.period.number}`);
  const boxHeight = 297 - 34 - 16;
  for (const [i, { purchase: p, blob }] of shots.entries()) {
    if (i) doc.addPage();
    doc.setFont('Plex', 'bold');
    doc.setFontSize(11);
    doc.text(`Закупка №${pad3(p.no)}`, PDF_MARGIN, 20);
    doc.setFont('Plex', 'normal');
    doc.setFontSize(10);
    doc.text(`${dFull(p.dt)} · ${reportTitle(p)} · ${money(p.amount)} сом · ${DOC[p.docType]}`, PDF_MARGIN, 26);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { width, height } = doc.getImageProperties(bytes);
    const scale = Math.min(PDF_WIDTH / width, boxHeight / height);
    doc.addImage(bytes, 'JPEG', PDF_MARGIN, 32, width * scale, height * scale);
  }
  pdfFooter(doc, `Приложение к отчёту ${r.period.number}`);
  return new File([doc.output('arraybuffer')], `Фото_документов_${r.fileBase}.pdf`, { type: 'application/pdf' });
}

/* Бэкап */

// Имя снимка в zip: photos/<год>-<номер>_<n>.jpg. Счётчик ведётся по году и номеру, а не по закупке:
// после загрузки архива номер может встретиться у двух закупок, и их фото не должны затирать друг друга.
function photoNamer(purchases) {
  const byId = new Map(purchases.map(p => [p.id, p]));
  const counts = new Map();
  return purchaseId => {
    const { year, no } = byId.get(purchaseId);
    const base = `${year}-${pad3(no)}`;
    const n = (counts.get(base) || 0) + 1;
    counts.set(base, n);
    return `photos/${base}_${n}.jpg`;
  };
}

// Открывает zip бэкапа или архива. notOurs — что сказать, если это чужой файл.
async function openZip(file, notOurs) {
  await loadVendor('vendor/jszip.min.js');
  try {
    const zip = await JSZip.loadAsync(file);
    return { zip, data: JSON.parse(await zip.file('data.json').async('string')) };
  } catch {
    throw new BackupError(notOurs);
  }
}

// Снимки из zip обратно в записи с Blob. Не хватает хотя бы одного — файл не принимается целиком.
async function unzipPhotos(zip, rows, missing) {
  const photos = [];
  for (const { file: name, ...meta } of rows) {
    const entry = typeof name === 'string' ? zip.file(name) : null;
    if (!entry) throw new BackupError(missing);
    photos.push({ ...meta, blob: new Blob([await entry.async('uint8array')], { type: 'image/jpeg' }) });
  }
  return photos;
}

async function buildBackup() {
  await loadVendor('vendor/jszip.min.js');
  const zip = new JSZip();
  const tables = {};
  for (const table of db.tables) {
    if (table.name !== 'photos') tables[table.name] = await table.toArray();
  }
  const photoName = photoNamer(tables.purchases);
  tables.photos = [];
  await db.photos.each(({ blob, ...meta }) => {
    const file = photoName(meta.purchaseId);
    zip.file(file, blob);
    tables.photos.push({ ...meta, file });
  });
  zip.file('data.json', JSON.stringify({ schemaVersion: db.verno, exportedAt: nowLocal(), tables }, null, 1));
  // JPEG уже сжат, повторное сжатие только потратит заряд.
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: 'application/zip' });
  return new File([blob], `backup_${nowLocal().slice(0, 10)}.zip`, { type: 'application/zip' });
}

// Разбирает и проверяет файл целиком до того, как что-либо будет изменено.
// Копии старых версий схемы приводятся здесь к текущей.
async function readBackup(file) {
  const { zip, data } = await openZip(file, 'Это не файл бэкапа.');
  if (data.kind === 'archive') throw new BackupError('Это файл архива. Он загружается кнопкой «Загрузить архив».');
  if (!(data.schemaVersion >= 1 && data.schemaVersion <= db.verno)) throw new BackupError('Копия сделана другой версией приложения.');
  const { tables } = data;
  if (tables && data.schemaVersion < 2 && Array.isArray(tables.purchases)) {
    tables.purchases.forEach(migratePurchaseV2);
    tables.bazaars = BAZAARS.map((name, i) => ({ id: i + 1, name, active: true }));
  }
  if (tables && data.schemaVersion < 4 && Array.isArray(tables.periods)) migrateTablesV4(tables);
  if (!tables || db.tables.some(table => !Array.isArray(tables[table.name]))) throw new BackupError('Файл бэкапа неполный.');
  const photos = await unzipPhotos(zip, tables.photos, 'В файле бэкапа не хватает фото.');
  return { exportedAt: data.exportedAt, tables: { ...tables, photos } };
}

/* Архив закрытых периодов: фото пережимаются, файл уходит с телефона через «Поделиться» */

const ARCHIVE_PHOTO_SIDE = 1100;
const ARCHIVE_PHOTO_QUALITY = 0.5;

// Архивируются закрытые периоды без непогашенных долгов. Погашение и его закупка уходят в архив только вместе:
// иначе после загрузки архива долг выглядел бы снова неоплаченным.
async function archivablePeriods() {
  const closed = await db.periods.where('status').equals('closed').toArray();
  const ids = new Set(closed.map(p => p.id));
  const purchasePeriod = new Map((await db.purchases.toArray()).map(p => [p.id, p.periodId]));
  (await getDebts()).forEach(d => ids.delete(d.periodId));
  const links = (await db.repayments.toArray()).map(r => [r.periodId, purchasePeriod.get(r.purchaseId)]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [a, b] of links) {
      if (ids.has(a) === ids.has(b)) continue;
      ids.delete(a);
      ids.delete(b);
      changed = true;
    }
  }
  return { periods: closed.filter(p => ids.has(p.id)), kept: closed.filter(p => !ids.has(p.id)) };
}

async function closedPeriodsData() {
  const { periods, kept } = await archivablePeriods();
  const periodIds = periods.map(p => p.id);
  const purchases = await db.purchases.where('periodId').anyOf(periodIds).toArray();
  const purchaseIds = purchases.map(p => p.id);
  const photos = await db.photos.where('purchaseId').anyOf(purchaseIds).toArray();
  return { periods, kept, periodIds, purchases, purchaseIds, photos, size: photos.reduce((sum, p) => sum + p.blob.size, 0) };
}

async function buildArchive(onProgress) {
  await loadVendor('vendor/jszip.min.js');
  const { periods, periodIds, purchases, purchaseIds, photos, size } = await closedPeriodsData();
  const zip = new JSZip();
  const photoName = photoNamer(purchases);
  const photoRows = [];
  let compressed = 0;
  for (const [i, { blob, ...meta }] of photos.entries()) {
    onProgress(i + 1, photos.length);
    const smaller = await compressPhoto(blob, ARCHIVE_PHOTO_SIDE, ARCHIVE_PHOTO_QUALITY);
    const best = smaller.size < blob.size ? smaller : blob;
    const file = photoName(meta.purchaseId);
    zip.file(file, best);
    compressed += best.size;
    photoRows.push({ ...meta, file });
  }
  const tables = {
    periods,
    purchases,
    photos: photoRows,
    advances: await db.advances.where('periodId').anyOf(periodIds).toArray(),
    returns: await db.returns.where('periodId').anyOf(periodIds).toArray(),
    repayments: await db.repayments.where('periodId').anyOf(periodIds).toArray(),
    suppliers: await db.suppliers.where('id').anyOf(purchases.map(p => p.supplierId)).toArray(),
    auditLog: await db.auditLog.filter(auditOf(purchaseIds, periodIds)).toArray(),
  };
  zip.file('data.json', JSON.stringify({ kind: 'archive', schemaVersion: db.verno, exportedAt: nowLocal(), tables }), { compression: 'DEFLATE' });
  const out = await zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: 'application/zip' });
  return {
    file: new File([out], `archive_${nowLocal().slice(0, 10)}.zip`, { type: 'application/zip' }),
    periodIds,
    label: periods.map(p => p.number).join(', '),
    before: size,
    after: compressed,
  };
}

// Файл читается обратно до удаления из приложения: повреждённый архив не должен стоить данных.
async function readArchive(file) {
  const { zip, data } = await openZip(file, 'Это не файл архива.');
  if (data.kind !== 'archive') throw new BackupError('Это не файл архива. Бэкап восстанавливается кнопкой «Восстановить из копии».');
  if (!(data.schemaVersion >= 1 && data.schemaVersion <= db.verno)) throw new BackupError('Архив сделан другой версией приложения.');
  const { tables } = data;
  if (tables && data.schemaVersion < 4 && Array.isArray(tables.periods)) migrateTablesV4(tables);
  const parts = ['periods', 'advances', 'purchases', 'photos', 'suppliers', 'returns', 'repayments', 'auditLog'];
  if (!tables || parts.some(part => !Array.isArray(tables[part]))) throw new BackupError('Файл архива неполный.');
  const photos = await unzipPhotos(zip, tables.photos, 'В файле архива не хватает фото.');
  return { exportedAt: data.exportedAt, tables: { ...tables, photos } };
}
