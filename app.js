'use strict';
// Интерфейс: экраны, форма закупки и выдачи. Запись и расчёты — в db.js.

const DOC = { ekkm: 'Чек ЭККМ', tov: 'Товарный чек', nakl: 'Накладная', esf: 'ЭСФ', none: 'Без документа' };
const PAY = { cash: 'Наличные', transfer: 'Перевод' };
const ADV_METHOD = { cash: 'Наличные', transfer: 'Перевод на карту' };
const TYPES = { goods: 'Товар', service: 'Услуга' };
const UNITS = ['шт', 'м', 'п.м.', 'м²', 'м³', 'кг', 'т', 'л', 'уп.', 'лист', 'меш.', 'рулон', 'рейс', 'час', 'услуга'];
const VIEWS = ['home', 'new', 'done', 'card', 'search', 'adv', 'items', 'report', 'close', 'more', 'dict', 'restore', 'archive', 'unarchive', 'wipe', 'log'];
const TABS = ['home', 'report', 'more'];
const PHOTO_MAX_SIDE = 1600;
const PHOTO_QUALITY = 0.7;
const DOUBLE_TAP_MS = 600;
const SUGGEST_LIMIT = 6;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad3 = n => String(n).padStart(3, '0');
const dShort = iso => { const [, m, d] = iso.slice(0, 10).split('-'); return `${d}.${m}`; };
const dFull = iso => { const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}.${m}.${y}`; };
const radioVal = name => (document.querySelector(`input[name="${name}"]:checked`) || {}).value;

// Опасное действие требует второго нажатия, и случайный двойной тап за него не считается.
function confirmTwice(button, label, confirmLabel, action) {
  let armedAt = 0;
  button.textContent = label;
  button.onclick = async () => {
    if (!armedAt) {
      armedAt = Date.now();
      button.textContent = confirmLabel;
      button.className = 'btn warnb full';
      return;
    }
    if (Date.now() - armedAt < DOUBLE_TAP_MS) return;
    button.disabled = true;
    await action();
  };
}

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

const NAV = { home: showHome, report: () => showReport(), more: showMore, card: () => openCard(cardId), search: () => openSearch() };

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
    return `<button class="item" type="button" data-advance="${x.id}"><span class="no">${dShort(x.date)}</span><span class="body"><span class="t">Выдача аванса<span class="tag adv">${tag}</span></span><span class="s">${esc(x.by)}</span></span><span class="a good">+${money(x.amount)}</span></button>`;
  }
  const storno = x.status === 'storno';
  const noDoc = x.docType === 'none';
  // Метки идут первыми: длинное имя поставщика не должно вытеснять их за многоточие.
  const tags = (x.type === 'service' ? '<span class="tag adv">услуга</span>' : '') +
    (storno ? '<span class="tag bad">сторно</span>' : noDoc ? '<span class="tag warn">нет документа</span>' : '');
  const doc = storno || noDoc ? '' : ` · ${DOC[x.docType]}`;
  return `<button class="item${storno ? ' storno' : ''}" type="button" data-card="${x.id}"><span class="no">№${pad3(x.no)}<br>${dShort(x.dt)}</span><span class="body"><span class="t">${esc(purchaseTitle(x) || x.supplierName)}</span><span class="s">${tags}${tags ? ' ' : ''}${esc(x.supplierName)}${doc}</span></span><span class="a">−${money(x.amount)}</span></button>`;
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
  const advance = e.target.closest('[data-advance]');
  if (advance) openAdvanceCard(Number(advance.dataset.advance));
  const b = e.target.closest('[data-card]');
  if (!b) return;
  cardBack = 'home';
  openCard(Number(b.dataset.card));
});

/* Новая закупка */

const form = {
  balance: 0,
  suppliers: [],
  bazaars: [],
  history: [],        // действующие закупки, новые первыми: источник подсказок
  lastSaved: null,    // для кнопки «Ещё у этого поставщика»
  touched: {},        // поля, выбранные вручную: подстановка их не трогает
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
  updateSuggestions();
}

$('f-type').addEventListener('change', applyPurchaseType);

function fillForm({ editing, no, balance, bazaars, suppliers, history, place, type, docType, payment }) {
  form.editing = editing;
  form.balance = balance;
  form.suppliers = suppliers.filter(s => !s.archived);
  form.bazaars = bazaars.filter(b => b.active);
  form.history = history;
  form.touched = {};
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
  renderPlaces(place);
  chips($('f-type'), 'type', Object.entries(TYPES), type);
  applyPurchaseType();
  chips($('f-doc'), 'doc', Object.entries(DOC), docType, 'none');
  chips($('f-pay'), 'pay', Object.entries(PAY), payment);
}

// prefill — кнопки «Ещё у этого поставщика» и «Повторить закупку»: остаётся ввести только сумму.
async function openNew(prefill = null) {
  const [no, sum, last, place, bazaars, suppliers, history] = await Promise.all([
    peekPurchaseNo(),
    getOpenPeriod().then(periodSummary),
    getLastPurchase(),
    getLastPlace(),
    db.bazaars.toArray(),
    db.suppliers.toArray(),
    getRecentPurchases(),
  ]);
  fillForm({
    editing: null,
    no,
    balance: sum.balance,
    bazaars,
    suppliers,
    history,
    place,
    type: prefill ? prefill.type : 'goods',
    docType: last ? last.docType : 'ekkm',
    payment: last ? last.payment : 'cash',
  });
  if (prefill) {
    $('f-name').value = prefill.goodsName || '';
    pickSupplier(prefill.supplierName);
  }
  updateOverspendNote();
  show('new');
}

async function openEdit(id) {
  const x = await db.purchases.get(id);
  const [sum, bazaars, suppliers, supplier, history] = await Promise.all([
    db.periods.get(x.periodId).then(periodSummary),
    db.bazaars.toArray(),
    db.suppliers.toArray(),
    db.suppliers.get(x.supplierId),
    getRecentPurchases(),
  ]);
  fillForm({
    editing: x,
    no: x.no,
    balance: sum.balance + x.amount,
    bazaars,
    suppliers,
    history,
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
  updateSuggestions();
  updateOverspendNote();
  show('new');
}

// Через Image, а не createImageBitmap: так Safari учитывает поворот из EXIF.
function compressPhoto(file, maxSide = PHOTO_MAX_SIDE, quality = PHOTO_QUALITY) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('toBlob вернул null'))), 'image/jpeg', quality);
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

/* Подсказки: повторы вводятся одним касанием и без клавиатуры. */

function renderSuggest(box, options, value, keepExact = false) {
  const query = value.trim().toLowerCase();
  const exact = !keepExact && options.some(o => o.toLowerCase() === query);
  const list = exact ? [] : options.filter(o => o.toLowerCase().includes(query)).slice(0, SUGGEST_LIMIT);
  box.innerHTML = list.map(o => `<button type="button" data-value="${esc(o)}">${esc(o)}</button>`).join('');
}

const typeOf = p => p.type || 'goods';

function nameOptions() {
  const type = radioVal('type');
  const names = form.history.filter(p => typeOf(p) === type).flatMap(p => [p.goodsName, ...p.items.map(i => i.name)]);
  return [...new Set(names.filter(Boolean))];
}

// Сначала те, у кого такое уже покупали, затем остальные поставщики.
function supplierOptions() {
  const type = radioVal('type');
  const byId = new Map(form.suppliers.map(s => [s.id, s.name]));
  const recent = form.history.filter(p => typeOf(p) === type).map(p => byId.get(p.supplierId)).filter(Boolean);
  return [...new Set([...recent, ...form.suppliers.map(s => s.name)])];
}

function updateSuggestions() {
  renderSuggest($('f-name-suggest'), nameOptions(), $('f-name').value);
  renderSuggest($('f-supplier-suggest'), supplierOptions(), $('f-supplier').value);
}

function setRadio(name, value) {
  const radio = [...document.querySelectorAll(`input[name="${name}"]`)].find(r => r.value === value);
  if (radio) radio.checked = true;
}

// Поставщик тянет за собой всё, что у него было в прошлый раз: телефон, базар, документ, оплату.
function applySupplierDefaults(name) {
  const query = name.trim().toLowerCase();
  const known = form.suppliers.find(s => s.name.toLowerCase() === query);
  if (!known) return;
  if (known.phone && !$('f-phone').value) $('f-phone').value = known.phone;
  const last = form.history.find(p => p.supplierId === known.id && typeOf(p) === radioVal('type'));
  const place = (last && last.place) || known.place;
  if (place && !form.touched.place) renderPlaces(place);
  if (!last || form.editing) return;
  if (!form.touched.doc) setRadio('doc', last.docType);
  if (!form.touched.pay) setRadio('pay', last.payment);
  resetNoDocConfirm();
}

function pickSupplier(name) {
  $('f-supplier').value = name;
  applySupplierDefaults(name);
  updateSuggestions();
}

// Известный товар сразу подставляет поставщика, у которого его брали в прошлый раз.
function pickName(name) {
  $('f-name').value = name;
  const last = form.history.find(p => p.goodsName === name || p.items.some(i => i.name === name));
  const supplier = last && form.suppliers.find(s => s.id === last.supplierId);
  if (supplier && !$('f-supplier').value) pickSupplier(supplier.name);
  updateSuggestions();
}

['doc', 'pay', 'place'].forEach(name => $('f-' + name).addEventListener('change', () => { form.touched[name] = true; }));
$('f-name').addEventListener('input', updateSuggestions);
$('f-supplier').addEventListener('input', e => {
  applySupplierDefaults(e.target.value);
  updateSuggestions();
});
$('f-name-suggest').addEventListener('click', e => {
  const b = e.target.closest('[data-value]');
  if (b) pickName(b.dataset.value);
});
$('f-supplier-suggest').addEventListener('click', e => {
  const b = e.target.closest('[data-value]');
  if (b) pickSupplier(b.dataset.value);
});

// Кнопка «Далее» на клавиатуре ведёт к следующему обязательному полю.
const NEXT_FIELD = { 'f-name': 'f-supplier', 'f-supplier': 'f-amount', 'f-phone': 'f-amount' };
$('v-new').addEventListener('keydown', e => {
  const next = NEXT_FIELD[e.target.id];
  if (e.key !== 'Enter' || !next) return;
  e.preventDefault();
  $(next).focus();
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
  form.lastSaved = { type, supplierName };
  const { balance } = await periodSummary(await db.periods.get(saved.periodId));
  $('d-no').textContent = pad3(saved.no);
  $('d-sum').innerHTML = `<span class="num">${money(amount)}</span> сом · ${esc(supplierName)}<br>Остаток: <span class="num">${money(balance)}</span> сом${balance < 0 ? ' (перерасход)' : ''}`;
  show('done');
}

$('f-save').onclick = submitPurchase;
$('d-more').onclick = () => openNew();
$('d-same').onclick = () => openNew(form.lastSaved);

/* Журнал */

const AUDIT_FIELDS = {
  type: 'Тип', goodsName: 'Наименование', amount: 'Сумма', supplierId: 'Поставщик', place: 'Базар', purposeId: 'Назначение', docType: 'Документ',
  payment: 'Оплата', comment: 'Комментарий', items: 'Позиции', status: 'Статус', stornoReason: 'Причина сторно',
  name: 'Название', phone: 'Телефон', archived: 'В архиве', active: 'Действует',
  deleted: 'Удалена запись', toArchive: 'В архив', fromArchive: 'Из архива',
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
  if (e.entity === 'archive') return 'Архив';
  if (e.entity === 'advance') return 'Выдача аванса';
  if (e.entity === 'purchase') {
    const purchase = ctx.purchases.get(e.entityId);
    return purchase ? `Закупка №${pad3(purchase.no)}` : 'Закупка (удалена)';
  }
  if (e.entity === 'period') return `Период ${ctx.periods.get(e.entityId) || ''}`;
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
let cardBack = 'home';   // куда возвращается «Назад»: на главную или к результатам поиска
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
  $('c-back').dataset.go = cardBack;
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
    (editable ? '<div class="btn-row"><button class="btn primary" type="button" id="c-items">Позиции</button><button class="btn" type="button" id="c-edit">Изменить</button></div><button class="btn full" type="button" id="c-repeat">Повторить закупку</button>' : '') +
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
    (editable ? '<div id="c-storno" class="stack"><button class="btn danger full" type="button" id="c-st-open">Сторнировать</button></div>' : '') +
    (period.status === 'open' ? '<button class="btn danger full" type="button" id="c-delete"></button>' : '<p class="muted hint">Чтобы изменить или удалить запись закрытого периода, сначала переоткройте его в Отчёте.</p>');
  if (editable) {
    $('c-items').onclick = () => openItems(id);
    $('c-edit').onclick = () => openEdit(id);
    $('c-repeat').onclick = () => openNew({ type: x.type, goodsName: x.goodsName, supplierName: supplier.name });
    $('c-st-open').onclick = () => openStorno(x);
  }
  if (period.status === 'open') {
    confirmTwice($('c-delete'), 'Удалить запись', `Нажмите ещё раз: удалить №${pad3(x.no)} насовсем`, async () => {
      await deletePurchase(id);
      await NAV[cardBack]();
      toast(`Закупка №${pad3(x.no)} удалена. Этот номер больше не выдаётся.`);
    });
  }
  show('card');
}

async function openAdvanceCard(id) {
  const x = await db.advances.get(id);
  const period = await db.periods.get(x.periodId);
  const row = (dt, dd) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`;
  releaseViewPhotos();
  $('c-back').dataset.go = 'home';
  $('c-title').textContent = 'Выдача аванса';
  $('c-body').innerHTML =
    `<div class="row"><span class="amount-hero">${money(x.amount)} сом</span></div>` +
    '<dl class="kv">' +
    row('Дата', dFull(x.date)) +
    row('Способ', ADV_METHOD[x.method]) +
    row('Кто выдал', esc(x.by)) +
    row('Период', esc(period.number)) +
    '</dl>' +
    (period.status === 'open' ? '<button class="btn danger full" type="button" id="c-delete"></button>' : '');
  if (period.status === 'open') {
    confirmTwice($('c-delete'), 'Удалить запись', 'Нажмите ещё раз: удалить выдачу насовсем', async () => {
      await deleteAdvance(id);
      await showHome();
      toast('Выдача удалена');
    });
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

const itemsForm = { purchase: null, balance: 0, known: new Map(), armedAt: 0, saving: false };

// Каждое наименование один раз, с последней ценой и единицей: вечером это главная экономия времени.
function knownItems(history) {
  const known = new Map();
  history.forEach(p => p.items.forEach(i => {
    const key = i.name.toLowerCase();
    if (!known.has(key)) known.set(key, i);
  }));
  return known;
}

function updateItemSuggest(row) {
  const box = row.querySelector('[data-suggest]');
  const priced = row.querySelector('.i-price').value.trim();
  renderSuggest(box, priced ? [] : [...itemsForm.known.values()].map(i => i.name), row.querySelector('.i-name').value, true);
}

async function openItems(id) {
  const purchase = await db.purchases.get(id);
  const [sum, receipt, history] = await Promise.all([
    db.periods.get(purchase.periodId).then(periodSummary),
    db.photos.where('purchaseId').equals(id).filter(p => p.kind === 'receipt').first(),
    getRecentPurchases(),
  ]);
  releaseViewPhotos();
  itemsForm.purchase = purchase;
  itemsForm.balance = sum.balance;
  itemsForm.known = knownItems(history);
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
    '<input class="input i-name" placeholder="Наименование, например Арматура d12" aria-label="Наименование" autocomplete="off" autocorrect="off" spellcheck="false">' +
    '<div class="suggest" data-suggest></div>' +
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
  updateItemSuggest(row);
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

$('i-rows').addEventListener('input', e => {
  updateItemSuggest(e.target.closest('.irow'));
  itemsChanged();
});
$('i-rows').addEventListener('click', e => {
  const pick = e.target.closest('[data-value]');
  if (pick) {
    const row = pick.closest('.irow');
    const item = itemsForm.known.get(pick.dataset.value.toLowerCase());
    row.querySelector('.i-name').value = item.name;
    row.querySelector('.i-unit').value = item.unit;
    row.querySelector('.i-price').value = money(item.price);
    updateItemSuggest(row);
    itemsChanged();
    row.querySelector('.i-qty').focus();
    return;
  }
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

/* Поиск по всем закупкам, включая закрытые периоды */

const search = { entries: [] };
const SEARCH_LIMIT = 100;

const foldText = text => text.toLowerCase().replace(/ё/g, 'е');
const compactMoney = tyiyn => money(tyiyn).replace(/\s/g, '');

function searchEntry(p, supplier) {
  const amounts = [p.amount, ...p.items.flatMap(i => [i.sum, i.price])].map(compactMoney);
  const words = [
    p.goodsName, ...p.items.map(i => i.name), supplier.name, supplier.phone, p.place, p.comment,
    DOC[p.docType], TYPES[p.type], pad3(p.no), dFull(p.dt), ...amounts,
  ];
  return { purchase: { ...p, supplierName: supplier.name }, amounts, date: dFull(p.dt), no: pad3(p.no), text: foldText(words.join(' ')) };
}

// Строка из цифр может быть суммой, датой или номером, поэтому проверяется целиком:
// «12 500» с пробелом — одна сумма, а не два слова.
function entryMatches(entry, query) {
  const q = foldText(query.trim());
  if (!q) return true;
  if (/^[№\d\s.,]+$/.test(q)) {
    const plain = q.replace(/[\s№]/g, '');
    const asMoney = plain.replace('.', ',');
    return entry.date.includes(plain) || entry.no === plain.padStart(3, '0') || entry.amounts.some(a => a.includes(asMoney));
  }
  return q.split(/\s+/).every(word => entry.text.includes(word));
}

function renderSearch() {
  const query = $('q-input').value;
  const found = search.entries.filter(e => entryMatches(e, query));
  const shown = found.slice(0, query.trim() ? SEARCH_LIMIT : 20).map(e => e.purchase);
  const total = sumAmounts(found.map(e => e.purchase).filter(p => p.status === 'active'));
  $('q-hint').textContent = query.trim()
    ? `Найдено: ${found.length}, на сумму ${money(total)} сом`
    : 'Например: профлист, Асанов, 28.10 или 12500. Ниже последние закупки.';
  $('q-list').innerHTML = shown.length
    ? shown.map(x => renderOperation({ kind: 'purchase', x })).join('')
    : (search.entries.length ? '<div class="empty">Ничего не найдено.</div>' : '<div class="empty">Закупок пока нет.</div>');
}

// Открывается сразу: иначе iPhone не покажет клавиатуру, она работает только прямо по нажатию.
async function openSearch(fresh = false) {
  if (fresh) $('q-input').value = '';
  show('search');
  if (fresh) $('q-input').focus();
  const [purchases, suppliers] = await Promise.all([db.purchases.toCollection().reverse().toArray(), db.suppliers.toArray()]);
  const byId = new Map(suppliers.map(s => [s.id, s]));
  search.entries = purchases.map(p => searchEntry(p, byId.get(p.supplierId)));
  renderSearch();
}

$('b-search').onclick = () => openSearch(true);
$('q-input').addEventListener('input', renderSearch);
$('q-list').addEventListener('click', e => {
  const b = e.target.closest('[data-card]');
  if (!b) return;
  cardBack = 'search';
  openCard(Number(b.dataset.card));
});

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
let reportView = 'stats';

// Длинный перечень номеров отодвигал бы графики за экран.
function withoutItemsLabel(list) {
  if (list.length <= 5) return list.map(p => '№' + pad3(p.no)).join(', ');
  return `${list.length} ${plural(list.length, 'закупка', 'закупки', 'закупок')}`;
}

let topView = 'suppliers';

const TOP_VIEWS = { suppliers: 'Поставщики', bazaars: 'Базары', goods: 'Товары' };

function renderMeter(r) {
  if (!r.issued) return '<div class="stat"><h3>Использование аванса</h3><div class="stat-note">Аванс в этом периоде не выдавался.</div></div>';
  const pct = Math.round(r.spent * 100 / r.issued);
  const level = pct > 100 ? 'bad' : pct >= 90 ? 'warn' : '';
  const note = pct > 100
    ? `Перерасход ${money(r.spent - r.issued)} сом`
    : `Потрачено ${money(r.spent)} из ${money(r.issued)} сом`;
  return `<div class="stat"><div class="stat-head"><h3>Использование аванса</h3><span class="stat-big">${pct}%</span></div>` +
    `<div class="meter" role="img" aria-label="Использовано ${pct}% аванса"><i class="${level}" style="width:${Math.min(pct, 100)}%"></i></div>` +
    `<div class="stat-note">${note}</div></div>`;
}

function renderRangeTotal(stats) {
  return `<div class="stat"><div class="stat-head"><h3>Потрачено</h3><span class="stat-big">${money(stats.spent)} сом</span></div>` +
    `<div class="stat-note">${stats.count} ${plural(stats.count, 'закупка', 'закупки', 'закупок')}</div></div>`;
}

function renderDays(stats) {
  const { buckets, unit } = stats;
  if (buckets.length < 2) return '';
  const max = Math.max(...buckets.map(b => b.sum));
  if (!max) return '';
  const peak = buckets.findIndex(b => b.sum === max);
  const columns = buckets.map((b, i) =>
    `<span class="col${i === peak ? ' on' : ''}"><i style="height:${b.sum ? Math.max(b.sum / max * 100, 3) : 0}%"></i></span>`
  ).join('');
  const label = buckets.map(b => `${b.label}: ${money(b.sum)} сом`).join(', ');
  return `<div class="stat"><h3>Расходы по ${unit}</h3>` +
    `<div class="stat-note" id="st-day">Больше всего: ${buckets[peak].label} — ${money(max)} сом</div>` +
    `<div class="plot" id="st-plot" role="img" aria-label="${esc(label)}">${columns}</div>` +
    `<div class="axis"><span>${buckets[0].label}</span><span>${buckets[buckets.length - 1].label}</span></div></div>`;
}

// Касание и ведение пальцем по графику: столбцы слишком узкие, чтобы попадать в каждый.
function bindDays(stats) {
  const plot = $('st-plot');
  if (!plot) return;
  const select = e => {
    const box = plot.getBoundingClientRect();
    const i = Math.min(Math.max(Math.floor((e.clientX - box.left) / box.width * stats.buckets.length), 0), stats.buckets.length - 1);
    [...plot.children].forEach((c, k) => c.classList.toggle('on', k === i));
    $('st-day').textContent = `${stats.buckets[i].label} — ${money(stats.buckets[i].sum)} сом`;
  };
  plot.addEventListener('click', select);
  plot.addEventListener('pointerdown', select);
  plot.addEventListener('pointermove', e => { if (e.buttons || e.pointerType === 'touch') select(e); });
}

function renderSplit(stats) {
  if (!stats.services || !stats.goodsSum) return '';
  // Малая, но ненулевая доля не должна выглядеть как ноль.
  const share = v => Math.max(Math.round(v * 100 / stats.spent), 1);
  return '<div class="stat"><h3>Товары и услуги</h3>' +
    `<div class="split" role="img" aria-label="Товары ${share(stats.goodsSum)}%, услуги ${share(stats.services)}%"><i class="a" style="flex:${stats.goodsSum}"></i><i class="b" style="flex:${stats.services}"></i></div>` +
    `<div class="legend"><div><i class="a"></i><span>Товары</span><span class="v">${money(stats.goodsSum)} · ${share(stats.goodsSum)}%</span></div>` +
    `<div><i class="b"></i><span>Услуги</span><span class="v">${money(stats.services)} · ${share(stats.services)}%</span></div></div></div>`;
}

function renderTopRows(rows) {
  if (!rows.length) return '<div class="stat-note">Пока нет данных.</div>';
  const max = rows.reduce((m, x) => Math.max(m, x.amount), 0);
  return rows.map(x =>
    `<div><div class="rank-h"><span>${esc(x.name)}</span><span class="v">${money(x.amount)}</span></div>` +
    (rows.length > 1 ? `<div class="rank-bar"><i class="${x.other ? 'other' : ''}" style="width:${x.amount / max * 100}%"></i></div>` : '') +
    '</div>'
  ).join('');
}

function renderStats(head, stats, emptyNote) {
  if (!stats.count) {
    $('r-stats').innerHTML = `${head}<div class="stat"><div class="stat-note">${emptyNote}</div></div>`;
    return;
  }
  $('r-stats').innerHTML = head + renderDays(stats) + renderSplit(stats) +
    '<div class="stat"><h3>Куда ушли деньги</h3><div class="chips" id="st-top"></div><div class="rank" id="st-rank"></div></div>';
  bindDays(stats);
  const drawTop = () => { $('st-rank').innerHTML = renderTopRows(stats.top[topView]); };
  chips($('st-top'), 'top', Object.entries(TOP_VIEWS), topView);
  $('st-top').onchange = e => { topView = e.target.value; drawTop(); };
  drawTop();
}

/* Диапазон статистики: отчётный период или любые даты, в том числе через несколько периодов */

const STAT_MODES = { period: 'Период', day: 'День', week: 'Неделя', month: 'Месяц', custom: 'Даты' };
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const statsRange = { mode: 'period', anchor: null, from: '', to: '' };
let statsDraw = 0;

const todayIso = () => nowLocal().slice(0, 10);

function rangeDates() {
  const { mode, anchor } = statsRange;
  if (mode === 'custom') return statsRange.from <= statsRange.to ? [statsRange.from, statsRange.to] : [statsRange.to, statsRange.from];
  if (mode === 'day') return [anchor, anchor];
  const date = dateOf(anchor);
  if (mode === 'week') {
    const monday = isoPlusDays(anchor, -((date.getDay() + 6) % 7));
    return [monday, isoPlusDays(monday, 6)];
  }
  return [isoDate(new Date(date.getFullYear(), date.getMonth(), 1)), isoDate(new Date(date.getFullYear(), date.getMonth() + 1, 0))];
}

function rangeLabel() {
  const [from, to] = rangeDates();
  if (statsRange.mode === 'day') return dFull(from);
  if (statsRange.mode === 'week') return `${dShort(from)} — ${dFull(to)}`;
  const date = dateOf(from);
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function stepRange(direction) {
  const { mode, anchor } = statsRange;
  if (mode === 'day') statsRange.anchor = isoPlusDays(anchor, direction);
  if (mode === 'week') statsRange.anchor = isoPlusDays(anchor, 7 * direction);
  if (mode === 'month') {
    const date = dateOf(anchor);
    statsRange.anchor = isoDate(new Date(date.getFullYear(), date.getMonth() + direction, 1));
  }
  drawStats();
}

async function drawStats() {
  const draw = ++statsDraw;
  const { mode } = statsRange;
  $('r-range-nav').hidden = mode === 'period' || mode === 'custom';
  $('r-range-dates').hidden = mode !== 'custom';
  if (mode === 'period') {
    const r = report;
    renderStats(renderMeter(r), reportStats(r.active, r.period.opened, r.end), 'Закупок пока нет. Графики появятся после первой закупки.');
    return;
  }
  const [from, to] = rangeDates();
  if (mode !== 'custom') {
    $('r-range-label').textContent = rangeLabel();
    $('r-next').disabled = to >= todayIso();
  }
  const active = await purchasesBetween(from, to);
  // Быстрое листание: ответ на прошлый запрос не должен затереть новый.
  if (draw !== statsDraw) return;
  const stats = reportStats(active, from, to);
  renderStats(stats.count ? renderRangeTotal(stats) : '', stats, 'За это время закупок нет.');
}

$('r-prev').onclick = () => stepRange(-1);
$('r-next').onclick = () => stepRange(1);
$('r-range').addEventListener('change', e => {
  statsRange.mode = e.target.value;
  statsRange.anchor = todayIso();
  if (statsRange.mode === 'custom' && !statsRange.from) {
    statsRange.from = isoPlusDays(todayIso(), -6);
    statsRange.to = todayIso();
    $('r-from').value = statsRange.from;
    $('r-to').value = statsRange.to;
  }
  drawStats();
});
['from', 'to'].forEach(key => $('r-' + key).addEventListener('change', e => {
  if (!e.target.value) return;
  statsRange[key] = e.target.value;
  drawStats();
}));

function applyReportView() {
  $('r-stats').hidden = reportView !== 'stats';
  $('r-filter').hidden = reportView !== 'stats';
  $('r-summary').hidden = reportView !== 'sum';
}

$('r-view').addEventListener('change', e => {
  reportView = e.target.value;
  applyReportView();
});

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
  if (r.withoutItems.length) notes.push(`<div class="note warn"><span>Без позиций: ${withoutItemsLabel(r.withoutItems)}. В отчёте у них будет только сумма.</span></div>`);
  $('r-notes').innerHTML = notes.join('');

  chips($('r-view'), 'rview', [['stats', 'Статистика'], ['sum', 'Итоги']], reportView);
  chips($('r-range'), 'range', Object.entries(STAT_MODES), statsRange.mode);
  await drawStats();
  applyReportView();
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
  if (r.withoutItems.length) notes.push(`<div class="note warn"><span>Без позиций: ${withoutItemsLabel(r.withoutItems)}. После закрытия внести их можно только через переоткрытие.</span></div>`);
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
  const photoSize = await db.photos.toArray().then(list => list.reduce((sum, p) => sum + p.blob.size, 0));
  const closedCount = await db.periods.where('status').equals('closed').count();
  $('s-usage').textContent = `Фото занимают ${formatSize(photoSize)}. Закрытых периодов: ${closedCount}.`;
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

/* Архив: место на телефоне освобождается, а записи можно вернуть */

const formatSize = bytes => (bytes < 1048576 ? `${Math.max(Math.round(bytes / 1024), 1)} КБ` : `${(bytes / 1048576).toFixed(1).replace('.', ',')} МБ`);

const archive = { built: null, unpack: null };

async function openArchive() {
  const { periods, purchases, photos, size } = await closedPeriodsData();
  const row = (label, value) => `<div><span>${label}</span><span class="v">${value}</span></div>`;
  archive.built = null;
  $('ar-sum').innerHTML = row('Закрытые периоды', periods.length) + row('Закупки', purchases.length) + row('Фото', `${photos.length}, ${formatSize(size)}`);
  $('ar-note').innerHTML = periods.length ? '' : '<div class="note warn"><span>Закрытых периодов пока нет. Архивируются только закрытые.</span></div>';
  $('ar-make').hidden = !periods.length;
  $('ar-make').disabled = false;
  $('ar-make').textContent = 'Создать архив';
  $('ar-remove').hidden = true;
  show('archive');
}

$('s-archive').onclick = openArchive;

$('ar-make').onclick = async () => {
  const button = $('ar-make');
  button.disabled = true;
  try {
    const built = archive.built || await buildArchive((i, n) => { button.textContent = `Сжатие фото ${i} из ${n}`; });
    archive.built = built;
    button.textContent = 'Проверка архива…';
    const check = await readArchive(built.file);
    if (check.tables.periods.length !== built.periodIds.length) throw new Error('Архив не совпал с данными');
    button.textContent = 'Сохраните файл';
    if (!(await deliverFile(built.file))) {
      button.textContent = 'Сохранить архив';
      button.disabled = false;
      return;
    }
  } catch (err) {
    console.error(err);
    toast('Архив не создался. Записи не изменились.');
    button.textContent = 'Создать архив';
    button.disabled = false;
    return;
  }
  const { before, after } = archive.built;
  $('ar-note').innerHTML = `<div class="note warn"><span>Файл создан: фото ${formatSize(before)} → ${formatSize(after)}. Убедитесь, что он сохранён в «Файлах», и только потом убирайте записи из приложения.</span></div>`;
  button.hidden = true;
  $('ar-remove').hidden = false;
  $('ar-remove').disabled = false;
  $('ar-remove').className = 'btn danger full';
  confirmTwice($('ar-remove'), 'Убрать из приложения', 'Нажмите ещё раз: файл сохранён, убрать', async () => {
    await removeArchivedPeriods(archive.built.periodIds, archive.built.label);
    archive.built = null;
    await showMore();
    toast('Закрытые периоды убраны из приложения');
  });
};

$('s-unarchive').addEventListener('change', async e => {
  const file = takePickedFile(e.target);
  if (!file) return;
  try {
    archive.unpack = await readArchive(file);
  } catch (err) {
    if (!(err instanceof BackupError)) console.error(err);
    toast(err instanceof BackupError ? err.message : 'Не удалось прочитать архив.');
    return;
  }
  const { tables, exportedAt } = archive.unpack;
  const row = (label, value) => `<div><span>${label}</span><span class="v">${value}</span></div>`;
  $('ua-sum').innerHTML = row('Архив от', esc(dFull(exportedAt))) +
    row('Периоды', esc(tables.periods.map(p => p.number).join(', '))) +
    row('Закупки', tables.purchases.length) + row('Фото', tables.photos.length);
  $('ua-do').disabled = false;
  show('unarchive');
});

$('ua-do').onclick = async () => {
  const button = $('ua-do');
  if (button.disabled) return;
  button.disabled = true;
  const { tables } = archive.unpack;
  try {
    await mergeArchive(archive.unpack, tables.periods.map(p => p.number).join(', '));
  } catch (err) {
    if (!(err instanceof BackupError)) console.error(err);
    toast(err instanceof BackupError ? err.message : 'Архив не загрузился. Текущие записи не изменились.');
    button.disabled = false;
    return;
  }
  archive.unpack = null;
  await showMore();
  toast('Архив загружен');
};

/* Удаление всех записей: чистый старт после пробы */

let wiping = false;

async function openWipe() {
  const [periods, purchases, photos] = await Promise.all([db.periods.count(), db.purchases.count(), db.photos.count()]);
  const row = (label, value) => `<div><span>${label}</span><span class="v">${value}</span></div>`;
  $('w-sum').innerHTML = row('Периоды', periods) + row('Закупки', purchases) + row('Фото', photos);
  $('w-backup').textContent = 'Сначала сохранить копию';
  $('w-word').value = '';
  $('w-do').disabled = true;
  show('wipe');
}

$('s-wipe').onclick = openWipe;
$('w-backup').onclick = e => runBackup(e.currentTarget, async () => { $('w-backup').textContent = 'Копия сохранена ✓'; });
$('w-word').addEventListener('input', e => {
  $('w-do').disabled = e.target.value.trim().toUpperCase() !== 'УДАЛИТЬ';
});

$('w-do').onclick = async () => {
  if (wiping) return;
  wiping = true;
  $('w-do').disabled = true;
  try {
    await wipeRecords();
  } catch (err) {
    console.error(err);
    toast('Удалить не удалось. Записи не изменились.');
    return;
  } finally {
    wiping = false;
  }
  form.lastSaved = null;
  await showHome();
  toast('Все записи удалены');
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
