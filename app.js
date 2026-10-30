'use strict';
// Интерфейс: экраны, форма закупки и выдачи. Запись и расчёты — в db.js.

const DOC = { ekkm: 'Чек ЭККМ', tov: 'Товарный чек', nakl: 'Накладная', esf: 'ЭСФ', none: 'Без документа' };
const PAY = { cash: 'Наличные', transfer: 'Перевод' };
const ADV_METHOD = { cash: 'Наличные', transfer: 'Перевод на карту' };
const TYPES = { goods: 'Товар', service: 'Услуга' };
const UNITS = ['шт', 'м', 'п.м.', 'м²', 'м³', 'кг', 'т', 'л', 'уп.', 'лист', 'меш.', 'рулон', 'рейс', 'час', 'услуга'];
const VIEWS = ['home', 'new', 'done', 'card', 'adv', 'items', 'report', 'close', 'more', 'dict', 'restore', 'log'];
const TABS = ['home', 'report', 'more'];
const PHOTO_MAX_SIDE = 1600;
const PHOTO_QUALITY = 0.7;
const DOUBLE_TAP_MS = 600;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad3 = n => String(n).padStart(3, '0');
const dShort = iso => { const [, m, d] = iso.slice(0, 10).split('-'); return `${d}.${m}`; };
const dFull = iso => { const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}.${m}.${y}`; };
const radioVal = name => (document.querySelector(`input[name="${name}"]:checked`) || {}).value;

function plural(n, one, few, many) {
  const a = n % 100, b = n % 10;
  if (a >= 11 && a <= 14) return many;
  return b === 1 ? one : b >= 2 && b <= 4 ? few : many;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function chips(el, name, options, value, warnKey) {
  el.innerHTML = options.map(([k, label]) =>
    `<label class="chip${k === warnKey ? ' warnchip' : ''}"><input type="radio" name="${name}" value="${esc(k)}"><span>${esc(label)}</span></label>`
  ).join('');
  // Только свойством: WebKit при перерисовке группы игнорирует атрибут checked и оставляет прежний выбор.
  const radio = [...el.querySelectorAll('input')].find(r => r.value === value);
  if (radio) radio.checked = true;
}

function show(view) {
  VIEWS.forEach(v => { $('v-' + v).hidden = v !== view; });
  $('tabbar').hidden = !TABS.includes(view);
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-current', String(t.dataset.go === view)));
  if (view !== 'card' && view !== 'items') releaseViewPhotos();
  window.scrollTo(0, 0);
}

async function showHome() {
  await renderHome();
  show('home');
}

const NAV = { home: showHome, report: () => showReport(), more: showMore, card: () => openCard(cardId) };

document.addEventListener('click', e => {
  const go = e.target.closest('[data-go]');
  if (go) NAV[go.dataset.go]();
});

// iOS держит приложение в памяти днями: дата в шапке не должна застывать.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('v-home').hidden) renderHome();
});

/* Главная */

function renderOperation({ kind, x }) {
  if (kind === 'advance') {
    const tag = x.method === 'cash' ? 'нал' : 'перевод';
    return `<div class="item static"><span class="no">${dShort(x.date)}</span><span class="body"><span class="t">Выдача аванса<span class="tag adv">${tag}</span></span><span class="s">${esc(x.by)}</span></span><span class="a good">+${money(x.amount)}</span></div>`;
  }
  const doc = x.docType === 'none' ? '<span class="tag warn">нет документа</span>' : DOC[x.docType];
  const storno = x.status === 'storno';
  const service = x.type === 'service' ? '<span class="tag adv">услуга</span> ' : '';
  return `<button class="item${storno ? ' storno' : ''}" type="button" data-card="${x.id}"><span class="no">№${pad3(x.no)}<br>${dShort(x.dt)}</span><span class="body"><span class="t">${esc(purchaseTitle(x) || x.supplierName)}</span><span class="s">${service}${esc(x.supplierName)} · ${storno ? '<span class="tag bad">сторно</span>' : doc}</span></span><span class="a">−${money(x.amount)}</span></button>`;
}

async function renderHome() {
  const period = await getCurrentPeriod();
  const closed = !!period && period.status === 'closed';
  const sum = await periodSummary(period);
  const suppliers = new Map((await db.suppliers.toArray()).map(s => [s.id, s.name]));

  $('h-org').textContent = await getSetting('org');
  $('h-date').textContent = dFull(nowLocal());
  $('h-period').textContent = period ? period.number + (closed ? ' · закрыт' : '') : 'Период не открыт';
  $('b-newp').hidden = !closed;
  $('h-actions').hidden = closed;
  $('h-bal').innerHTML = `${money(sum.balance)}<small>сом</small>`;
  $('h-bal').classList.toggle('neg', sum.balance < 0);
  $('h-in').textContent = money(sum.issued);
  $('h-out').textContent = money(sum.spent);

  const notes = [];
  if (closed) notes.push(`<div class="note warn"><span>Период закрыт ${dFull(period.closed)}. Возврат в кассу: <b class="num">${money(period.ret)} сом</b>.</span></div>`);
  if (sum.balance < 0) notes.push(`<div class="note bad"><span>Перерасход <b class="num">${money(-sum.balance)} сом</b>. Будет отражён в отчёте отдельной строкой.</span></div>`);
  if (sum.noDoc > 0) notes.push(`<div class="note warn"><span>Без документов: <b class="num">${money(sum.noDoc)} сом</b>. Бухгалтерия может не принять эти расходы.</span></div>`);
  const reminder = await backupReminder();
  if (reminder) notes.push(`<div class="note info"><span>${reminder.never ? `Бэкапа ещё не было, закупок: ${reminder.count}` : `Последний бэкап ${reminder.days} дн. назад, закупок с тех пор: ${reminder.count}`}. Данные хранятся только на этом телефоне.</span></div><button class="btn full" type="button" id="h-backup">Сохранить копию</button>`);
  $('h-notes').innerHTML = notes.join('');
  if (reminder) $('h-backup').onclick = e => runBackup(e.currentTarget, renderHome);

  const operations = [
    ...sum.purchases.map(p => ({
      kind: 'purchase', at: p.dt,
      x: { ...p, supplierName: suppliers.get(p.supplierId) },
    })),
    ...sum.advances.map(a => ({ kind: 'advance', at: a.date + 'T00:00', x: a })),
  ].sort((a, b) => b.at.localeCompare(a.at) || b.x.id - a.x.id);

  $('h-count').textContent = `${sum.count} ${plural(sum.count, 'закупка', 'закупки', 'закупок')}`;
  $('h-list').innerHTML = operations.length
    ? operations.map(renderOperation).join('')
    : '<div class="empty">Операций пока нет. Начните с выдачи аванса.</div>';
}

$('b-new').onclick = () => openNew();
$('b-adv').onclick = openAdvance;
$('b-newp').onclick = async () => {
  await openNewPeriod();
  await showHome();
  toast('Открыт новый период. Добавьте выдачу аванса.');
};
$('h-list').addEventListener('click', e => {
  const b = e.target.closest('[data-card]');
  if (b) openCard(Number(b.dataset.card));
});

/* Новая закупка */

const form = {
  balance: 0,
  suppliers: [],
  bazaars: [],
  editing: null,      // закупка в режиме правки, null для новой
  session: {},        // новая форма — новый объект: по нему отсекается фото, дожатое для прошлой формы
  receipt: null,
  receiptUrl: null,
  receiptPick: null,  // последняя съёмка чека: пересъёмка отменяет предыдущую
  goods: [],          // [{ blob, url }]
  photoJobs: [],
  noDocArmedAt: 0,
  saving: false,
};

function setReceipt(blob) {
  if (form.receiptUrl) URL.revokeObjectURL(form.receiptUrl);
  form.receipt = blob;
  form.receiptUrl = blob ? URL.createObjectURL(blob) : null;
  $('f-photo-empty').hidden = !!blob;
  $('f-photo-done').hidden = !blob;
  $('f-photo-img').src = form.receiptUrl || '';
}

function renderGoods() {
  $('f-goods-list').innerHTML = form.goods.map((g, i) =>
    `<span class="thumb"><img src="${g.url}" alt="Фото товара ${i + 1}"><button type="button" data-del-goods="${i}" aria-label="Удалить фото товара ${i + 1}"><span>×</span></button></span>`
  ).join('');
  const empty = radioVal('type') === 'service' ? 'Сделать фото' : 'Сфотографировать товар';
  $('f-goods-title').textContent = form.goods.length ? 'Добавить ещё фото' : empty;
}

function clearGoods() {
  form.goods.forEach(g => URL.revokeObjectURL(g.url));
  form.goods = [];
  renderGoods();
}

function renderPlaces(selected) {
  const names = form.bazaars.map(b => b.name);
  if (selected && !names.includes(selected)) names.push(selected);
  chips($('f-place'), 'place', names.map(n => [n, n]), selected);
}

// Услуге (доставке, погрузке) базар обычно не нужен, а подставленный из прошлой закупки был бы ложным.
function applyPurchaseType() {
  const service = radioVal('type') === 'service';
  $('f-name-label').textContent = service ? 'Наименование услуги' : 'Наименование товара';
  $('f-name').placeholder = service ? 'Например, доставка портером' : 'Например, профлист С21';
  $('f-goods-label').textContent = service ? 'Фото' : 'Фото товара';
  $('f-supplier-label').textContent = service ? 'Исполнитель' : 'Поставщик';
  $('f-phone-label').textContent = service ? 'Телефон исполнителя' : 'Телефон поставщика';
  $('f-place-field').hidden = service;
  renderGoods();
}

$('f-type').addEventListener('change', applyPurchaseType);

function fillForm({ editing, no, balance, bazaars, suppliers, place, type, docType, payment }) {
  form.editing = editing;
  form.balance = balance;
  form.suppliers = suppliers.filter(s => !s.archived);
  form.bazaars = bazaars.filter(b => b.active);
  form.session = {};
  form.receiptPick = null;
  form.photoJobs = [];
  setReceipt(null);
  clearGoods();
  resetNoDocConfirm();

  $('n-title').textContent = editing ? 'Правка закупки' : 'Новая закупка';
  $('n-no').textContent = '№' + pad3(no);
  $('f-back').dataset.go = editing ? 'card' : 'home';
  $('f-receipt-block').hidden = !!editing;
  $('f-goods-field').hidden = !!editing;
  const itemized = !!editing && editing.items.length > 0;
  $('f-amount').readOnly = itemized;
  $('f-amount-hint').hidden = !itemized;
  ['f-name', 'f-amount', 'f-supplier', 'f-phone', 'f-comment'].forEach(id => { $(id).value = ''; });
  $('f-place-new').hidden = true;
  $('f-place-add').hidden = false;
  $('dl-sup').innerHTML = form.suppliers.map(s => `<option value="${esc(s.name)}"></option>`).join('');
  renderPlaces(place);
  chips($('f-type'), 'type', Object.entries(TYPES), type);
  applyPurchaseType();
  chips($('f-doc'), 'doc', Object.entries(DOC), docType, 'none');
  chips($('f-pay'), 'pay', Object.entries(PAY), payment);
}

async function openNew() {
  const [no, sum, last, place, bazaars, suppliers] = await Promise.all([
    peekPurchaseNo(),
    getOpenPeriod().then(periodSummary),
    getLastPurchase(),
    getLastPlace(),
    db.bazaars.toArray(),
    db.suppliers.toArray(),
  ]);
  fillForm({
    editing: null,
    no,
    balance: sum.balance,
    bazaars,
    suppliers,
    place,
    type: 'goods',
    docType: last ? last.docType : 'ekkm',
    payment: last ? last.payment : 'cash',
  });
  updateOverspendNote();
  show('new');
}

async function openEdit(id) {
  const x = await db.purchases.get(id);
  const [sum, bazaars, suppliers, supplier] = await Promise.all([
    db.periods.get(x.periodId).then(periodSummary),
    db.bazaars.toArray(),
    db.suppliers.toArray(),
    db.suppliers.get(x.supplierId),
  ]);
  fillForm({
    editing: x,
    no: x.no,
    balance: sum.balance + x.amount,
    bazaars,
    suppliers,
    place: x.place,
    type: x.type,
    docType: x.docType,
    payment: x.payment,
  });
  $('f-name').value = x.goodsName;
  $('f-amount').value = money(x.amount);
  $('f-supplier').value = supplier.name;
  $('f-phone').value = supplier.phone;
  $('f-comment').value = x.comment;
  updateOverspendNote();
  show('new');
}

// Через Image, а не createImageBitmap: так Safari учитывает поворот из EXIF.
function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('toBlob вернул null'))), 'image/jpeg', PHOTO_QUALITY);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Фото не открывается'));
    };
    img.src = url;
  });
}

function takePickedFile(input) {
  const file = input.files && input.files[0];
  input.value = '';
  return file;
}

function startPhotoJob(file, onReady) {
  form.photoJobs.push(compressPhoto(file).then(onReady, () => toast('Не удалось открыть фото. Попробуйте снять ещё раз.')));
}

$('f-photo').addEventListener('change', e => {
  const file = takePickedFile(e.target);
  if (!file) return;
  const pick = form.receiptPick = {};
  startPhotoJob(file, blob => { if (form.receiptPick === pick) setReceipt(blob); });
});

$('f-goods').addEventListener('change', e => {
  const file = takePickedFile(e.target);
  if (!file) return;
  const { session } = form;
  startPhotoJob(file, blob => {
    if (form.session !== session) return;
    form.goods.push({ blob, url: URL.createObjectURL(blob) });
    renderGoods();
  });
});

$('f-goods-list').addEventListener('click', e => {
  const b = e.target.closest('[data-del-goods]');
  if (!b) return;
  const [removed] = form.goods.splice(Number(b.dataset.delGoods), 1);
  URL.revokeObjectURL(removed.url);
  renderGoods();
});

function updateOverspendNote() {
  const amount = parseMoney($('f-amount').value) || 0;
  const over = amount - form.balance;
  $('f-over').innerHTML = amount > 0 && over > 0
    ? `<div class="note bad"><span>Сумма больше остатка. Перерасход составит <b class="num">${money(over)} сом</b>, сохранить можно.</span></div>`
    : '';
}
$('f-amount').addEventListener('input', updateOverspendNote);

// Телефон и базар известного поставщика подставляются сами: быстрый режим экономит нажатия.
$('f-supplier').addEventListener('input', e => {
  const name = e.target.value.trim().toLowerCase();
  const known = form.suppliers.find(s => s.name.toLowerCase() === name);
  if (!known) return;
  if (known.phone && !$('f-phone').value) $('f-phone').value = known.phone;
  if (known.place) renderPlaces(known.place);
});

$('f-place-add').onclick = () => {
  $('f-place-add').hidden = true;
  $('f-place-new').hidden = false;
  $('f-place-name').value = '';
  $('f-place-name').focus();
};

$('f-place-save').onclick = async () => {
  const name = $('f-place-name').value.trim();
  if (!name) { $('f-place-name').focus(); return; }
  const known = form.bazaars.find(b => b.name.toLowerCase() === name.toLowerCase());
  if (known) {
    renderPlaces(known.name);
  } else {
    try {
      await addBazaar(name);
    } catch (err) {
      // Такой базар есть в архиве: для этой закупки он всё равно подходит.
      if (!(err instanceof NameTakenError)) throw err;
    }
    form.bazaars = (await db.bazaars.toArray()).filter(b => b.active);
    renderPlaces(name);
  }
  $('f-place-new').hidden = true;
  $('f-place-add').hidden = false;
};

function resetNoDocConfirm() {
  form.noDocArmedAt = 0;
  $('f-save').textContent = form.editing ? 'Сохранить изменения' : 'Сохранить закупку';
  $('f-save').className = 'btn primary full';
  $('f-warn').innerHTML = '';
}

function armNoDocConfirm() {
  form.noDocArmedAt = Date.now();
  $('f-warn').innerHTML = '<div class="note warn"><span>Закупка без документа пойдёт в отчёт отдельной строкой. Бухгалтерия может не принять её в расходы.</span></div>';
  $('f-save').textContent = 'Сохранить без документа';
  $('f-save').className = 'btn warnb full';
  $('f-warn').scrollIntoView({ block: 'center', behavior: 'smooth' });
}

$('f-doc').addEventListener('change', resetNoDocConfirm);

async function submitPurchase() {
  if (form.saving) return;
  const goodsName = $('f-name').value.trim();
  const amount = parseMoney($('f-amount').value);
  const supplierName = $('f-supplier').value.trim();
  const docType = radioVal('doc');
  const type = radioVal('type');
  const service = type === 'service';
  if (!goodsName) { toast(`Укажите наименование ${service ? 'услуги' : 'товара'}.`); $('f-name').focus(); return; }
  if (!supplierName) { toast(`Укажите ${service ? 'исполнителя' : 'поставщика'}.`); $('f-supplier').focus(); return; }
  if (!amount) { toast('Введите сумму закупки.'); $('f-amount').focus(); return; }
  if (docType === 'none' && !(form.editing && form.editing.docType === 'none')) {
    if (!form.noDocArmedAt) { armNoDocConfirm(); return; }
    // Двойной тап не должен сойти за осознанное второе нажатие.
    if (Date.now() - form.noDocArmedAt < DOUBLE_TAP_MS) return;
  }

  const data = {
    type,
    goodsName,
    amount,
    supplierName,
    phone: $('f-phone').value.trim(),
    place: service ? '' : radioVal('place') || '',
    docType,
    payment: radioVal('pay'),
    comment: $('f-comment').value.trim(),
  };

  form.saving = true;
  $('f-save').disabled = true;
  let saved;
  try {
    if (form.editing) {
      await updatePurchase(form.editing.id, data);
    } else {
      await Promise.all(form.photoJobs);
      const photos = form.goods.map(g => ({ kind: 'goods', blob: g.blob }));
      if (form.receipt) photos.unshift({ kind: 'receipt', blob: form.receipt });
      saved = await savePurchase(data, photos);
    }
  } catch (err) {
    console.error(err);
    toast(form.editing ? 'Изменения не сохранились. Попробуйте ещё раз.' : 'Закупка не сохранилась, номер не израсходован. Попробуйте ещё раз.');
    return;
  } finally {
    form.saving = false;
    $('f-save').disabled = false;
  }

  if (form.editing) {
    await openCard(form.editing.id);
    toast('Изменения сохранены');
    return;
  }
  const { balance } = await periodSummary(await db.periods.get(saved.periodId));
  $('d-no').textContent = pad3(saved.no);
  $('d-sum').innerHTML = `<span class="num">${money(amount)}</span> сом · ${esc(supplierName)}<br>Остаток: <span class="num">${money(balance)}</span> сом${balance < 0 ? ' (перерасход)' : ''}`;
  show('done');
}

$('f-save').onclick = submitPurchase;
$('d-more').onclick = () => openNew();

/* Журнал */

const AUDIT_FIELDS = {
  type: 'Тип', goodsName: 'Наименование', amount: 'Сумма', supplierId: 'Поставщик', place: 'Базар', purposeId: 'Назначение', docType: 'Документ',
  payment: 'Оплата', comment: 'Комментарий', items: 'Позиции', status: 'Статус', stornoReason: 'Причина сторно',
  name: 'Название', phone: 'Телефон', archived: 'В архиве', active: 'Действует',
  ret: 'Возврат', closed: 'Дата закрытия', revision: 'Редакция', reopenReason: 'Причина переоткрытия',
};
const AUDIT_STATUS = { active: 'Активна', storno: 'Сторно', open: 'Открыт', closed: 'Закрыт' };

async function auditContext() {
  const [suppliers, purposes, bazaars, purchases, periods] = await Promise.all([db.suppliers.toArray(), db.purposes.toArray(), db.bazaars.toArray(), db.purchases.toArray(), db.periods.toArray()]);
  const names = list => new Map(list.map(x => [x.id, x.name]));
  return {
    suppliers: names(suppliers),
    purposes: names(purposes),
    bazaars: names(bazaars),
    purchases: new Map(purchases.map(p => [p.id, p])),
    periods: new Map(periods.map(p => [p.id, p.number])),
  };
}

function auditValue(field, value, ctx) {
  if (value === null || value === undefined || value === '') return '—';
  switch (field) {
    case 'amount': case 'ret': return `${money(value)} сом`;
    case 'closed': return dFull(value);
    case 'supplierId': return ctx.suppliers.get(value);
    case 'purposeId': return ctx.purposes.get(value);
    case 'docType': return DOC[value];
    case 'payment': return PAY[value];
    case 'status': return AUDIT_STATUS[value];
    case 'type': return TYPES[value];
    case 'archived': case 'active': return value ? 'да' : 'нет';
    case 'items': return value.length ? `${value.length} поз. на ${money(value.reduce((s, i) => s + i.sum, 0))} сом` : 'нет';
    default: return value;
  }
}

function auditSubject(e, ctx) {
  if (e.entity === 'purchase') return `Закупка №${pad3(ctx.purchases.get(e.entityId).no)}`;
  if (e.entity === 'period') return `Период ${ctx.periods.get(e.entityId)}`;
  if (e.entity === 'supplier') return `Поставщик «${ctx.suppliers.get(e.entityId)}»`;
  if (e.entity === 'bazaar') return `Базар «${ctx.bazaars.get(e.entityId)}»`;
  return `Назначение «${ctx.purposes.get(e.entityId)}»`;
}

function renderAudit(e, ctx, withSubject) {
  const change = `${AUDIT_FIELDS[e.field]}: ${auditValue(e.field, e.before, ctx)} → ${auditValue(e.field, e.after, ctx)}`;
  return `<div class="log-row"><span class="when">${dFull(e.at)}, ${e.at.slice(11, 16)}${withSubject ? ' · ' + esc(auditSubject(e, ctx)) : ''}</span>${esc(change)}</div>`;
}

async function openLog() {
  const [entries, ctx] = await Promise.all([db.auditLog.orderBy(':id').reverse().limit(300).toArray(), auditContext()]);
  $('l-list').innerHTML = entries.length
    ? entries.map(e => renderAudit(e, ctx, true)).join('')
    : '<div class="empty">Изменений пока не было.</div>';
  show('log');
}

$('s-log').onclick = openLog;

/* Карточка закупки */

let cardId = null;
let viewPhotoUrls = [];
let stornoSaving = false;

function viewPhotoUrl(blob) {
  const url = URL.createObjectURL(blob);
  viewPhotoUrls.push(url);
  return url;
}

function releaseViewPhotos() {
  viewPhotoUrls.forEach(url => URL.revokeObjectURL(url));
  viewPhotoUrls = [];
}

function renderItemsTable(x) {
  const rows = x.items.map(i =>
    `<tr><td>${esc(i.name)}</td><td class="r">${String(i.qty).replace('.', ',')}</td><td>${esc(i.unit)}</td><td class="r">${money(i.price)}</td><td class="r">${money(i.sum)}</td></tr>`
  ).join('');
  return `<div class="scroll"><table class="items-table"><thead><tr><th>Товар</th><th class="r">Кол-во</th><th>Ед.</th><th class="r">Цена</th><th class="r">Сумма</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td colspan="4">Итого</td><td class="r">${money(x.amount)}</td></tr></tfoot></table></div>`;
}

async function openCard(id) {
  cardId = id;
  const x = await db.purchases.get(id);
  const [supplier, period, photos, history, ctx] = await Promise.all([
    db.suppliers.get(x.supplierId),
    db.periods.get(x.periodId),
    db.photos.where('purchaseId').equals(id).toArray(),
    db.auditLog.where('entityId').equals(id).filter(e => e.entity === 'purchase').toArray(),
    auditContext(),
  ]);
  releaseViewPhotos();
  const shots = photos.map(p => ({ kind: p.kind, url: viewPhotoUrl(p.blob) }));
  const receipts = shots.filter(p => p.kind === 'receipt');
  const goods = shots.filter(p => p.kind === 'goods');
  const storno = x.status === 'storno';
  const editable = !storno && period.status === 'open';
  const service = x.type === 'service';

  const row = (dt, dd) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`;
  const badge = storno ? '<span class="tag bad">сторно</span>' : x.docType === 'none' ? '<span class="tag warn">нет документа</span>' : '';
  $('c-title').innerHTML = `Закупка <span class="num">№${pad3(x.no)}</span>`;
  $('c-body').innerHTML =
    `<div class="row"><span class="amount-hero${storno ? ' muted struck' : ''}">${money(x.amount)} сом</span><span class="spacer"></span>${badge}</div>` +
    (storno ? `<div class="note bad"><span><b>Сторнирована.</b> ${esc(x.stornoReason)}</span></div>` : '') +
    '<dl class="kv">' +
    row('Дата', `<span class="tnum">${dFull(x.dt)}, ${x.dt.slice(11, 16)}</span>`) +
    (purchaseTitle(x) ? row(service ? 'Услуга' : 'Товар', esc(purchaseTitle(x))) : '') +
    row(service ? 'Исполнитель' : 'Поставщик', esc(supplier.name)) +
    (supplier.phone ? row('Телефон', esc(supplier.phone)) : '') +
    (x.place ? row('Базар', esc(x.place)) : '') +
    row('Документ', DOC[x.docType]) +
    row('Оплата', PAY[x.payment]) +
    row('Период', esc(period.number)) +
    (x.comment ? row('Комментарий', esc(x.comment)) : '') +
    '</dl>' +
    (editable ? '<div class="btn-row"><button class="btn primary" type="button" id="c-items">Позиции</button><button class="btn" type="button" id="c-edit">Изменить</button></div>' : '') +
    '<div class="section-h"><h3>Позиции</h3></div>' +
    (x.items.length ? renderItemsTable(x) : '<div class="ph-none"><span>Позиции не внесены.</span></div>') +
    '<div class="section-h"><h3>Фото документа</h3></div>' +
    (receipts.length
      ? receipts.map(p => `<img class="photo-full" src="${p.url}" alt="Фото документа №${pad3(x.no)}">`).join('')
      : `<div class="ph-none"><span>Фото не прикреплено. Бумажный документ с номером <b class="num">№${pad3(x.no)}</b> в бухгалтерии.</span></div>`) +
    (goods.length
      ? `<div class="section-h"><h3>${service ? 'Фото' : 'Фото товара'}</h3></div>` + goods.map(p => `<img class="photo-full" src="${p.url}" alt="Фото товара №${pad3(x.no)}">`).join('')
      : '') +
    (history.length
      ? `<div class="section-h"><h3>История изменений</h3></div><div class="list">${history.map(e => renderAudit(e, ctx, false)).join('')}</div>`
      : '') +
    (editable ? '<div id="c-storno" class="stack"><button class="btn danger full" type="button" id="c-st-open">Сторнировать</button></div>' : '');
  if (editable) {
    $('c-items').onclick = () => openItems(id);
    $('c-edit').onclick = () => openEdit(id);
    $('c-st-open').onclick = () => openStorno(x);
  }
  show('card');
}

function openStorno(x) {
  $('c-storno').innerHTML =
    '<div class="field"><label class="label" for="c-reason">Причина сторно</label><textarea class="input" id="c-reason" placeholder="Необязательно"></textarea></div>' +
    `<div class="btn-row"><button class="btn danger" type="button" id="c-st-do">Сторнировать №${pad3(x.no)}</button><button class="btn" type="button" id="c-st-cancel">Отмена</button></div>` +
    '<p class="muted hint">Номер не освобождается. Закупка останется в отчёте отдельным блоком и не войдёт в сумму.</p>';
  $('c-reason').focus();
  $('c-st-cancel').onclick = () => openCard(x.id);
  $('c-st-do').onclick = async () => {
    if (stornoSaving) return;
    const reason = $('c-reason').value.trim() || null;
    stornoSaving = true;
    try {
      await stornoPurchase(x.id, reason);
    } catch (err) {
      console.error(err);
      toast('Сторно не сохранилось. Попробуйте ещё раз.');
      return;
    } finally {
      stornoSaving = false;
    }
    await openCard(x.id);
    toast(`Закупка №${pad3(x.no)} сторнирована`);
  };
}

/* Позиции. Вносятся после рынка, по чеку, в уже сохранённую закупку. */

const itemsForm = { purchase: null, balance: 0, armedAt: 0, saving: false };

async function openItems(id) {
  const purchase = await db.purchases.get(id);
  const [sum, receipt] = await Promise.all([
    db.periods.get(purchase.periodId).then(periodSummary),
    db.photos.where('purchaseId').equals(id).filter(p => p.kind === 'receipt').first(),
  ]);
  releaseViewPhotos();
  itemsForm.purchase = purchase;
  itemsForm.balance = sum.balance;
  $('i-no').textContent = '№' + pad3(purchase.no);
  $('i-receipt').hidden = !receipt;
  $('i-receipt-img').src = receipt ? viewPhotoUrl(receipt.blob) : '';
  $('i-rows').innerHTML = '';
  const firstRow = { name: purchase.goodsName, unit: purchase.type === 'service' ? 'услуга' : 'шт' };
  (purchase.items.length ? purchase.items : [firstRow]).forEach(addItemRow);
  resetItemsConfirm();
  updateItemsTotals();
  show('items');
}

function addItemRow(item) {
  const row = document.createElement('div');
  row.className = 'irow';
  row.innerHTML =
    '<input class="input i-name" placeholder="Наименование, например Арматура d12" aria-label="Наименование" autocomplete="off">' +
    `<div class="igrid"><select class="input i-unit" aria-label="Единица">${UNITS.map(u => `<option>${u}</option>`).join('')}</select>` +
    '<input class="input i-qty" inputmode="decimal" placeholder="Кол-во" aria-label="Количество" autocomplete="off">' +
    '<input class="input i-price" inputmode="decimal" placeholder="Цена" aria-label="Цена" autocomplete="off"></div>' +
    '<div class="ifoot"><span class="muted">Сумма: <b class="num" data-sum>0</b> сом</span><button class="linkbtn bad" type="button" data-del>Удалить</button></div>';
  if (item) row.querySelector('.i-name').value = item.name;
  if (item && item.unit) row.querySelector('.i-unit').value = item.unit;
  if (item && item.qty) {
    row.querySelector('.i-qty').value = String(item.qty).replace('.', ',');
    row.querySelector('.i-price').value = money(item.price);
  }
  $('i-rows').appendChild(row);
}

function readRow(row) {
  const name = row.querySelector('.i-name').value.trim();
  const qtyText = row.querySelector('.i-qty').value;
  const priceText = row.querySelector('.i-price').value;
  const qty = parseQty(qtyText);
  const price = parseMoney(priceText);
  const priced = qty > 0 && price > 0 && Number.isSafeInteger(Math.round(qty * 1000) * price);
  const sum = priced ? itemSum(qty, price) : 0;
  return {
    row,
    sum,
    blank: !name && !qtyText.trim() && !priceText.trim(),
    item: name && priced ? { name, unit: row.querySelector('.i-unit').value, qty, price, sum } : null,
  };
}

const readRows = () => [...$('i-rows').children].map(readRow);

function updateItemsTotals() {
  const rows = readRows();
  rows.forEach(r => { r.row.querySelector('[data-sum]').textContent = money(r.sum); });
  const total = rows.reduce((sum, r) => sum + r.sum, 0);
  const { amount } = itemsForm.purchase;
  const diff = total - amount;
  const balance = itemsForm.balance - diff;
  const notes = [];
  if (total && diff) {
    notes.push(`<div class="note warn"><span>Сумма закупки <b class="num">${money(amount)} сом</b>, по позициям <b class="num">${money(total)} сом</b>. Разница <b class="num">${diff > 0 ? '+' : ''}${money(diff)} сом</b>.</span></div>`);
    if (balance < 0 && diff > 0) notes.push(`<div class="note bad"><span>Перерасход составит <b class="num">${money(-balance)} сом</b>.</span></div>`);
  }
  $('i-total').textContent = `${money(total)} сом`;
  $('i-notes').innerHTML = notes.join('');
}

function resetItemsConfirm() {
  itemsForm.armedAt = 0;
  $('i-save').textContent = 'Сохранить позиции';
  $('i-save').className = 'btn primary full';
}

function itemsChanged() {
  resetItemsConfirm();
  updateItemsTotals();
}

$('i-rows').addEventListener('input', itemsChanged);
$('i-rows').addEventListener('click', e => {
  if (!e.target.closest('[data-del]')) return;
  e.target.closest('.irow').remove();
  if (!$('i-rows').children.length) addItemRow(null);
  itemsChanged();
});
$('i-add').onclick = () => addItemRow(null);

async function submitItems() {
  if (itemsForm.saving) return;
  const rows = readRows().filter(r => !r.blank);
  if (rows.some(r => !r.item)) { toast('Заполните наименование, количество и цену в каждой позиции.'); return; }
  const items = rows.map(r => r.item);
  const total = items.reduce((sum, i) => sum + i.sum, 0);
  if (items.length && total !== itemsForm.purchase.amount) {
    if (!itemsForm.armedAt) {
      itemsForm.armedAt = Date.now();
      $('i-save').textContent = `Заменить сумму на ${money(total)} сом`;
      $('i-save').className = 'btn warnb full';
      return;
    }
    if (Date.now() - itemsForm.armedAt < DOUBLE_TAP_MS) return;
  }

  const { id } = itemsForm.purchase;
  itemsForm.saving = true;
  $('i-save').disabled = true;
  try {
    await savePurchaseItems(id, items);
  } catch (err) {
    console.error(err);
    toast('Позиции не сохранились. Попробуйте ещё раз.');
    return;
  } finally {
    itemsForm.saving = false;
    $('i-save').disabled = false;
  }
  await openCard(id);
  toast('Позиции сохранены');
}

$('i-save').onclick = submitItems;

/* Отдача файлов */

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Safari разрешает «Поделиться» только сразу после нажатия. Если файл собирался дольше, просим ещё одно.
function offerFile(file) {
  return new Promise(resolve => {
    $('ready-name').textContent = `Файл готов: ${file.name}`;
    $('ready').hidden = false;
    $('ready-send').onclick = async () => {
      $('ready').hidden = true;
      resolve(await deliverFile(file));
    };
  });
}

// true, если файл передан. Отмена в окне «Поделиться» — не ошибка, а false.
async function deliverFile(file) {
  const data = { files: [file], title: file.name };
  if (!navigator.canShare || !navigator.canShare(data)) {
    downloadFile(file);
    return true;
  }
  try {
    await navigator.share(data);
    return true;
  } catch (err) {
    if (err.name === 'AbortError') return false;
    if (err.name === 'NotAllowedError') return offerFile(file);
    throw err;
  }
}

async function exportFile(button, build) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    const file = await build();
    if (file) await deliverFile(file);
    else toast('Фото документов в этом периоде нет.');
  } catch (err) {
    console.error(err);
    toast('Не удалось сформировать файл. Попробуйте ещё раз.');
  } finally {
    button.disabled = false;
  }
}

async function makeBackup() {
  const delivered = await deliverFile(await buildBackup());
  if (delivered) await setSetting('lastBackupAt', nowLocal());
  return delivered;
}

async function runBackup(button, onDone) {
  button.disabled = true;
  try {
    if (await makeBackup()) await onDone();
  } catch (err) {
    console.error(err);
    toast('Бэкап не создался. Попробуйте ещё раз.');
  } finally {
    button.disabled = false;
  }
}

/* Отчёт */

let report = null;

function renderReportSum(r) {
  const row = (label, value, cls = '') => `<div><span>${label}</span><span class="v ${cls}">${value}</span></div>`;
  return row('Выдано авансом', money(r.issued)) +
    row(`Израсходовано (${r.count} ${plural(r.count, 'закупка', 'закупки', 'закупок')})`, money(r.spent)) +
    row('<span class="muted">в т.ч. услуги</span>', money(r.services)) +
    row('<span class="muted">в т.ч. без документов</span>', money(r.noDoc), 'warn') +
    row('<span class="muted">Сторно, не учитывается</span>', money(r.stornoSum), 'muted') +
    row('Возвращено в кассу', money(r.ret)) +
    `<div class="total"><span>${balanceLabel(r)}</span><span class="v ${r.balance < 0 ? 'bad' : ''}">${money(Math.abs(r.balance))} сом</span></div>`;
}

async function showReport(periodId) {
  const [periods, current] = await Promise.all([db.periods.toArray(), getCurrentPeriod()]);
  const period = periods.find(p => p.id === periodId) || current;
  $('r-period-field').hidden = periods.length < 2;
  $('r-body').hidden = !period;
  $('r-reopen').innerHTML = '';
  if (!period) {
    $('r-status').textContent = '';
    $('r-sub').textContent = 'Отчёт появится после первой выдачи аванса.';
    $('r-notes').innerHTML = '';
    show('report');
    return;
  }

  const r = report = await buildReport(period);
  const closed = period.status === 'closed';
  $('r-period').innerHTML = periods.slice().reverse().map(p => `<option value="${p.id}"${p.id === period.id ? ' selected' : ''}>${esc(p.number)}</option>`).join('');
  $('r-status').textContent = (closed ? 'Закрыт' : 'Открыт') + (period.revision ? ` · редакция ${period.revision}` : '');
  $('r-sub').textContent = `${period.number} · ${dFull(period.opened)} — ${closed ? dFull(period.closed) : 'по сегодня'}${r.userName ? ' · ' + r.userName : ''}`;

  const notes = [];
  if (!r.userName) notes.push('<div class="note warn"><span>ФИО не указано. Заполните его в Настройках, оно попадёт в шапку отчёта.</span></div>');
  if (r.withoutItems.length) notes.push(`<div class="note warn"><span>Без позиций: ${r.withoutItems.map(p => '№' + pad3(p.no)).join(', ')}. В отчёте у них будет только сумма.</span></div>`);
  $('r-notes').innerHTML = notes.join('');

  $('r-sum').innerHTML = renderReportSum(r);
  $('r-table').innerHTML =
    '<thead><tr><th>№</th><th>Дата</th><th>Товар / услуга</th><th>Поставщик</th><th>Документ</th><th>Оплата</th><th class="r">Сумма</th></tr></thead><tbody>' +
    r.purchases.map(p => `<tr${p.status === 'storno' ? ' class="struck"' : ''}><td class="num">${pad3(p.no)}</td><td class="tnum">${dShort(p.dt)}</td><td>${esc(reportTitle(p))}</td><td>${esc(p.supplier)}</td><td>${DOC[p.docType]}</td><td>${PAY[p.payment]}</td><td class="r">${money(p.amount)}</td></tr>`).join('') +
    `</tbody><tfoot><tr><td colspan="6">Итого без сторно</td><td class="r">${money(r.spent)}</td></tr></tfoot>`;

  $('r-close').hidden = closed;
  if (closed) $('r-reopen').innerHTML = '<button class="btn danger full" type="button" id="r-reopen-open">Переоткрыть период</button>';
  if (closed) $('r-reopen-open').onclick = openReopen;
  show('report');
}

$('r-period').onchange = e => showReport(Number(e.target.value));
$('r-xlsx').onclick = e => exportFile(e.currentTarget, () => reportXlsx(report));
$('r-pdf').onclick = e => exportFile(e.currentTarget, () => reportPdf(report));
$('r-photos').onclick = e => exportFile(e.currentTarget, () => photosPdf(report));

function openReopen() {
  const { period } = report;
  $('r-reopen').innerHTML =
    '<div class="field"><label class="label" for="r-reason">Причина переоткрытия</label><textarea class="input" id="r-reason" placeholder="Например, бухгалтерия нашла ошибку"></textarea></div>' +
    `<div class="btn-row"><button class="btn danger" type="button" id="r-reopen-do">Переоткрыть</button><button class="btn" type="button" id="r-reopen-cancel">Отмена</button></div>` +
    `<p class="muted hint">Отчёт получит пометку «редакция ${period.revision + 1}». Новые закупки попадут в этот период.</p>`;
  $('r-reason').focus();
  $('r-reopen-cancel').onclick = () => showReport(period.id);
  $('r-reopen-do').onclick = async e => {
    const reason = $('r-reason').value.trim();
    if (!reason) { toast('Укажите причину.'); $('r-reason').focus(); return; }
    e.currentTarget.disabled = true;
    try {
      await reopenPeriod(period.id, reason);
    } catch (err) {
      e.target.disabled = false;
      if (err instanceof PeriodOpenError) {
        toast('Сначала закройте текущий открытый период.');
      } else {
        console.error(err);
        toast('Не удалось переоткрыть период.');
      }
      return;
    }
    await showReport(period.id);
    toast(`Период ${period.number} переоткрыт`);
  };
}

/* Закрытие периода */

const closing = { backedUp: false, saving: false };

function updateCloseButton() {
  $('cl-do').disabled = !($('cl-check').checked && closing.backedUp);
}

function openClose() {
  const r = report;
  const available = r.issued - r.spent;
  closing.backedUp = false;
  $('cl-sum').innerHTML =
    `<div><span>Выдано</span><span class="v">${money(r.issued)}</span></div>` +
    `<div><span>Израсходовано</span><span class="v">${money(r.spent)}</span></div>` +
    `<div class="total"><span>${available < 0 ? 'Перерасход' : 'Остаток на руках'}</span><span class="v ${available < 0 ? 'bad' : ''}">${money(Math.abs(available))} сом</span></div>`;
  const notes = [];
  if (r.withoutItems.length) notes.push(`<div class="note warn"><span>Без позиций: ${r.withoutItems.map(p => '№' + pad3(p.no)).join(', ')}. После закрытия внести их можно только через переоткрытие.</span></div>`);
  if (available < 0) notes.push(`<div class="note bad"><span>Перерасход <b class="num">${money(-available)} сом</b> будет зафиксирован в отчёте.</span></div>`);
  $('cl-notes').innerHTML = notes.join('');
  $('cl-ret').value = money(Math.max(available, 0));
  $('cl-check-l').textContent = `Бумажные документы (${r.docsCount} шт.) сданы в бухгалтерию`;
  $('cl-check').checked = false;
  $('cl-backup').textContent = 'Сохранить бэкап';
  $('cl-backup').disabled = false;
  updateCloseButton();
  show('close');
}

$('r-close').onclick = openClose;
$('cl-check').onchange = updateCloseButton;

$('cl-backup').onclick = async e => {
  const button = e.currentTarget;
  button.disabled = true;
  try {
    closing.backedUp = await makeBackup();
  } catch (err) {
    console.error(err);
    toast('Бэкап не создался. Попробуйте ещё раз.');
  }
  button.disabled = closing.backedUp;
  if (closing.backedUp) button.textContent = 'Бэкап сохранён ✓';
  updateCloseButton();
};

$('cl-do').onclick = async () => {
  if (closing.saving) return;
  const r = report;
  const ret = parseMoney($('cl-ret').value);
  if (ret === null) { toast('Введите сумму возврата.'); $('cl-ret').focus(); return; }
  if (ret > Math.max(r.issued - r.spent, 0)) { toast('Возврат не может превышать остаток.'); $('cl-ret').focus(); return; }
  closing.saving = true;
  try {
    await closePeriod(r.period.id, ret);
  } catch (err) {
    console.error(err);
    toast('Период не закрылся. Попробуйте ещё раз.');
    return;
  } finally {
    closing.saving = false;
  }
  await showReport(r.period.id);
  toast(`Период ${r.period.number} закрыт`);
};

/* Настройки и справочники */

const dict = { kind: null, record: null, saving: false };

async function showMore() {
  const [userName, org, lastBackupAt, suppliers, bazaars, purchases] = await Promise.all([
    getSetting('userName'),
    getSetting('org'),
    getSetting('lastBackupAt'),
    db.suppliers.toArray(),
    db.bazaars.toArray(),
    db.purchases.where('status').equals('active').toArray(),
  ]);
  const byName = (a, b) => a.name.localeCompare(b.name, 'ru');
  $('s-name').value = userName || '';
  $('s-org').value = org || '';
  $('s-sup-n').textContent = suppliers.length;
  $('s-backup-note').textContent = `Данные хранятся только на этом телефоне. Последняя копия: ${lastBackupAt ? dFull(lastBackupAt) : 'ещё не делалась'}.`;
  $('s-baz').innerHTML = bazaars.sort(byName).map(b =>
    `<button class="item plain" type="button" data-dict="bazaar" data-id="${b.id}"><span class="t">${esc(b.name)}${b.active ? '' : '<span class="tag warn">архив</span>'}</span></button>`
  ).join('');
  $('s-sup').innerHTML = suppliers.length
    ? suppliers.sort(byName).map(s => {
      const own = purchases.filter(p => p.supplierId === s.id);
      return `<button class="item plain" type="button" data-dict="supplier" data-id="${s.id}"><span class="t">${esc(s.name)}${s.archived ? '<span class="tag warn">архив</span>' : ''}</span><span class="s tnum">${own.length} закуп. · ${money(sumAmounts(own))}</span></button>`;
    }).join('')
    : '<div class="empty">Появятся после первой закупки.</div>';
  show('more');
}

$('s-backup').onclick = e => runBackup(e.currentTarget, showMore);

/* Восстановление из бэкапа */

const restore = { backup: null, armedAt: 0, saving: false };

function resetRestoreConfirm() {
  restore.armedAt = 0;
  $('rs-do').textContent = 'Заменить все данные';
  $('rs-do').className = 'btn danger full';
}

$('s-restore').addEventListener('change', async e => {
  const file = takePickedFile(e.target);
  if (!file) return;
  let backup;
  try {
    backup = await readBackup(file);
  } catch (err) {
    if (!(err instanceof BackupError)) console.error(err);
    toast(err instanceof BackupError ? err.message : 'Не удалось прочитать файл бэкапа.');
    return;
  }
  const [periods, purchases, photos] = await Promise.all([db.periods.count(), db.purchases.count(), db.photos.count()]);
  const row = (label, inFile, now) => `<div><span>${label}</span><span class="v">в копии ${inFile}, сейчас ${now}</span></div>`;
  const { tables } = backup;
  restore.backup = backup;
  $('rs-sum').innerHTML =
    `<div><span>Копия от</span><span class="v">${dFull(backup.exportedAt)}, ${esc(backup.exportedAt.slice(11, 16))}</span></div>` +
    row('Периоды', tables.periods.length, periods) +
    row('Закупки', tables.purchases.length, purchases) +
    row('Фото', tables.photos.length, photos);
  $('rs-backup').hidden = !purchases;
  $('rs-backup').textContent = 'Сначала сохранить текущие данные';
  resetRestoreConfirm();
  show('restore');
});

$('rs-backup').onclick = e => runBackup(e.currentTarget, async () => { $('rs-backup').textContent = 'Текущие данные сохранены ✓'; });

$('rs-do').onclick = async () => {
  if (restore.saving) return;
  if (!restore.armedAt) {
    restore.armedAt = Date.now();
    $('rs-do').textContent = 'Нажмите ещё раз: данные будут заменены';
    $('rs-do').className = 'btn warnb full';
    return;
  }
  if (Date.now() - restore.armedAt < DOUBLE_TAP_MS) return;
  restore.saving = true;
  $('rs-do').disabled = true;
  try {
    await restoreAll(restore.backup.tables, restore.backup.exportedAt);
  } catch (err) {
    console.error(err);
    resetRestoreConfirm();
    toast('Восстановить не удалось. Текущие данные не изменились.');
    return;
  } finally {
    restore.saving = false;
    $('rs-do').disabled = false;
  }
  restore.backup = null;
  await showHome();
  toast('Данные восстановлены из копии');
};

$('s-name').onchange = e => setSetting('userName', e.target.value.trim());
$('s-org').onchange = async e => {
  const org = e.target.value.trim();
  if (org) await setSetting('org', org);
  else e.target.value = await getSetting('org');
};

function dictError(err) {
  if (err instanceof NameTakenError) return 'Такое название уже есть.';
  console.error(err);
  return 'Не сохранилось. Попробуйте ещё раз.';
}

$('s-addbaz').onclick = async () => {
  const name = $('s-newbaz').value.trim();
  if (!name) return;
  try {
    await addBazaar(name);
  } catch (err) {
    toast(dictError(err));
    return;
  }
  $('s-newbaz').value = '';
  await showMore();
  toast('Базар добавлен');
};

async function openDict(kind, id) {
  const supplier = kind === 'supplier';
  const record = await (supplier ? db.suppliers : db.bazaars).get(id);
  dict.kind = kind;
  dict.record = record;
  $('d-title').textContent = supplier ? 'Поставщик' : 'Базар';
  $('d-sup-fields').hidden = !supplier;
  $('d-name').value = record.name;
  $('d-place').value = record.place || '';
  $('d-phone').value = record.phone || '';
  $('d-comment').value = record.comment || '';
  $('d-hide').checked = supplier ? record.archived : !record.active;
  show('dict');
}

['s-baz', 's-sup'].forEach(id => $(id).addEventListener('click', e => {
  const b = e.target.closest('[data-dict]');
  if (b) openDict(b.dataset.dict, Number(b.dataset.id));
}));

async function submitDict() {
  if (dict.saving) return;
  const name = $('d-name').value.trim();
  if (!name) { toast('Укажите название.'); $('d-name').focus(); return; }
  const hide = $('d-hide').checked;
  dict.saving = true;
  try {
    if (dict.kind === 'supplier') {
      await saveSupplier(dict.record.id, {
        name,
        place: $('d-place').value.trim(),
        phone: $('d-phone').value.trim(),
        comment: $('d-comment').value.trim(),
        archived: hide,
      });
    } else {
      await saveBazaar(dict.record.id, { name, active: !hide });
    }
  } catch (err) {
    toast(dictError(err));
    return;
  } finally {
    dict.saving = false;
  }
  await showMore();
  toast('Сохранено');
}

$('d-save').onclick = submitDict;

/* Выдача аванса */

let advanceSaving = false;

function openAdvance() {
  $('a-amount').value = '';
  $('a-by').value = 'Бухгалтерия';
  $('a-date').value = nowLocal().slice(0, 10);
  chips($('a-method'), 'method', Object.entries(ADV_METHOD), 'cash');
  show('adv');
}

async function submitAdvance() {
  if (advanceSaving) return;
  const amount = parseMoney($('a-amount').value);
  if (!amount) { toast('Введите сумму аванса.'); $('a-amount').focus(); return; }

  advanceSaving = true;
  $('a-save').disabled = true;
  try {
    await addAdvance({
      amount,
      method: radioVal('method'),
      by: $('a-by').value.trim() || '—',
      date: $('a-date').value || nowLocal().slice(0, 10),
    });
  } catch (err) {
    console.error(err);
    toast('Выдача не сохранилась. Попробуйте ещё раз.');
    return;
  } finally {
    advanceSaving = false;
    $('a-save').disabled = false;
  }

  await showHome();
  toast(`Выдача ${money(amount)} сом добавлена`);
}

$('a-save').onclick = submitAdvance;

/* Запуск */

window.addEventListener('unhandledrejection', e => {
  console.error(e.reason);
  toast('Ошибка приложения. Закройте его и откройте снова.');
});

async function start() {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(console.error);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.error);
  try {
    await db.open();
    await showHome();
  } catch (err) {
    console.error(err);
    $('h-notes').innerHTML = '<div class="note bad"><span>Не удалось открыть хранилище на этом устройстве. Данные недоступны.</span></div>';
    show('home');
  }
}

start();
