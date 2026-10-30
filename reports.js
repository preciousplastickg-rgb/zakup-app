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
    ret: period.ret,
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
    return { label, sum: 0 };
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

// Статистика за даты идёт через все отчётные периоды.
async function purchasesBetween(from, to) {
  const list = await db.purchases.where('dt').between(from, `${to}T99`, true, true).filter(p => p.status === 'active').toArray();
  return withSuppliers(list);
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
    ['Выдано авансом', xlsMoney(r.issued)],
    ['Израсходовано', xlsMoney(r.spent)],
    ['в т.ч. услуги', xlsMoney(r.services)],
    ['в т.ч. без документов', xlsMoney(r.noDoc)],
    ['Сторно, не учитывается', xlsMoney(r.stornoSum)],
    ['Возвращено в кассу', xlsMoney(r.ret)],
    [balanceLabel(r), xlsMoney(Math.abs(r.balance))],
    [],
    ['Выдачи'],
    ...r.advances.map(a => [`${dFull(a.date)}, ${ADV_METHOD[a.method]}, ${a.by}`, xlsMoney(a.amount)]),
  ], [34, 40]);

  addSheet(wb, 'Реестр', [
    ['№', 'Дата', 'Тип', 'Товар / услуга', 'Документ', 'Оплата', 'Сумма', 'Комментарий'],
    ...r.active.map(p => [pad3(p.no), date(p), p.type === 'service' ? 'Услуга' : 'Товар', p.title, DOC[p.docType], PAY[p.payment], xlsMoney(p.amount), p.comment]),
    ['Итого', '', '', '', '', '', xlsMoney(r.spent)],
  ], [7, 11, 8, 40, 15, 11, 14, 30]);

  addSheet(wb, 'Позиции', [
    ['№ закупки', 'Дата', 'Наименование', 'Ед.', 'Кол-во', 'Цена', 'Сумма'],
    ...r.active.flatMap(p => (p.items.length
      ? p.items.map(i => [pad3(p.no), date(p), i.name, i.unit, i.qty, xlsMoney(i.price), xlsMoney(i.sum)])
      : [[pad3(p.no), date(p), `${p.title}: позиции не внесены`, '', '', '', xlsMoney(p.amount)]])),
    ['Итого', '', '', '', '', '', xlsMoney(r.spent)],
  ], [10, 11, 42, 7, 9, 13, 14]);

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

  y = pdfHeading(doc, y, 'Реестр закупок');
  y = pdfTable(doc, {
    startY: y,
    head: [['№', 'Дата', 'Товар / услуга', 'Документ', 'Оплата', { content: 'Сумма', styles: right }]],
    body: pdfRegistryRows(r),
    foot: [[{ content: 'Итого без сторно', colSpan: 5 }, { content: money(r.spent), styles: right }]],
    showFoot: 'lastPage',
    columnStyles: { 0: { cellWidth: 10 }, 1: { cellWidth: 20 }, 3: { cellWidth: 26 }, 4: { cellWidth: 19 }, 5: { cellWidth: 24 } },
  });

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
      ['Выдано авансом', { content: money(r.issued), styles: right }],
      ['Израсходовано', { content: money(r.spent), styles: right }],
      ['в т.ч. услуги', { content: money(r.services), styles: right }],
      ['Возвращено в кассу', { content: money(r.ret), styles: right }],
      [{ content: balanceLabel(r), styles: { fontStyle: 'bold' } }, { content: `${money(Math.abs(r.balance))} сом`, styles: { ...right, fontStyle: 'bold' } }],
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
  const shots = [];
  for (const purchase of r.active) {
    const photos = await db.photos.where('purchaseId').equals(purchase.id).filter(p => p.kind === 'receipt').toArray();
    photos.forEach(photo => shots.push({ purchase, blob: photo.blob }));
  }
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

// В имени файла есть год: нумерация обнуляется в январе, и №001 разных лет иначе затёрли бы друг друга.
async function buildBackup() {
  await loadVendor('vendor/jszip.min.js');
  const zip = new JSZip();
  const tables = {};
  for (const table of db.tables) {
    if (table.name !== 'photos') tables[table.name] = await table.toArray();
  }
  const purchases = new Map(tables.purchases.map(p => [p.id, p]));
  const perPurchase = new Map();
  tables.photos = [];
  await db.photos.each(({ blob, ...meta }) => {
    const n = (perPurchase.get(meta.purchaseId) || 0) + 1;
    perPurchase.set(meta.purchaseId, n);
    const { year, no } = purchases.get(meta.purchaseId);
    const file = `photos/${year}-${pad3(no)}_${n}.jpg`;
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
  await loadVendor('vendor/jszip.min.js');
  let zip;
  let data;
  try {
    zip = await JSZip.loadAsync(file);
    data = JSON.parse(await zip.file('data.json').async('string'));
  } catch {
    throw new BackupError('Это не файл бэкапа.');
  }
  if (!(data.schemaVersion >= 1 && data.schemaVersion <= db.verno)) throw new BackupError('Копия сделана другой версией приложения.');
  const { tables } = data;
  if (tables && data.schemaVersion < 2 && Array.isArray(tables.purchases)) {
    tables.purchases.forEach(migratePurchaseV2);
    tables.bazaars = BAZAARS.map((name, i) => ({ id: i + 1, name, active: true }));
  }
  if (!tables || db.tables.some(table => !Array.isArray(tables[table.name]))) throw new BackupError('Файл бэкапа неполный.');

  const photos = [];
  for (const { file: name, ...meta } of tables.photos) {
    const entry = typeof name === 'string' ? zip.file(name) : null;
    if (!entry) throw new BackupError('В файле бэкапа не хватает фото.');
    photos.push({ ...meta, blob: new Blob([await entry.async('uint8array')], { type: 'image/jpeg' }) });
  }
  return { exportedAt: data.exportedAt, tables: { ...tables, photos } };
}
