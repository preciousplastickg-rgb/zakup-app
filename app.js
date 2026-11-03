'use strict';
// Интерфейс: экраны, форма закупки и выдачи. Запись и расчёты — в db.js.

const DOC = { ekkm: 'Чек ЭККМ', tov: 'Товарный чек', nakl: 'Накладная', esf: 'ЭСФ', none: 'Без документа' };
const PAY = { cash: 'Наличные', transfer: 'Перевод', debt: 'В долг' };
const MONEY_METHOD = { cash: 'Наличные', transfer: 'Перевод' };   // так отдают деньги: возврат, погашение долга
const ADV_METHOD = { cash: 'Наличные', transfer: 'Перевод на карту' };
const TYPES = { goods: 'Товар', service: 'Услуга' };
const UNITS = ['шт', 'м', 'п.м.', 'м²', 'м³', 'кг', 'т', 'л', 'уп.', 'лист', 'меш.', 'рулон', 'рейс', 'час', 'услуга'];
const VIEWS = ['home', 'new', 'done', 'card', 'search', 'adv', 'items', 'report', 'close', 'more', 'dict', 'restore', 'archive', 'unarchive', 'wipe', 'log', 'list', 'supplier', 'entry', 'repay'];
const PHOTO_VIEWS = ['card', 'items', 'supplier'];   // экраны со снимками из базы: ссылки на них живут, пока экран открыт
const TABS = ['home', 'report', 'more'];
const ANDROID = /Android/.test(navigator.userAgent);
// Chrome на Android отклоняет эти файлы в «Поделиться», хотя canShare отвечает true.
const ANDROID_NO_SHARE = /\.(xlsx|zip)$/;
const PHOTO_MAX_SIDE = 1600;
const PHOTO_QUALITY = 0.7;
const DOUBLE_TAP_MS = 600;
const LEAVE_CONFIRM_MS = 4000;
const SUGGEST_LIMIT = 6;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad3 = n => String(n).padStart(3, '0');
const dShort = iso => { const [, m, d] = iso.slice(0, 10).split('-'); return `${d}.${m}`; };
const dFull = iso => { const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}.${m}.${y}`; };
const radioVal = name => (document.querySelector(`input[name="${name}"]:checked`) || {}).value;

// Опасное действие требует второго нажатия, и случайный двойной тап за него не считается.
function confirmTwice(button, label, confirmLabel, action, armedClass = 'btn warnb full') {
  let armedAt = 0;
  button.textContent = label;
  button.onclick = async () => {
    if (!armedAt) {
      armedAt = Date.now();
      button.textContent = confirmLabel;
      button.className = armedClass;
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
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function chips(el, name, options, value, warnKey) {
  el.innerHTML = options.map(([k, label]) =>
    `<label class="chip${k === warnKey ? ' warnchip' : ''}"><input type="radio" name="${name}" value="${esc(k)}"><span>${esc(label)}</span></label>`
  ).join('');
  // Только свойством: WebKit при перерисовке группы игнорирует атрибут checked и оставляет прежний выбор.
  const radio = [...el.querySelectorAll('input')].find(r => r.value === value);
  if (radio) radio.checked = true;
}

let currentView = null;
let viewSnapshot = '';
let leaveWarnedAt = 0;
let peek = null;         // пока соседний экран готовится к свайпу, show только запоминает его
let backArmed = false;   // Android: есть запись в истории, которую заберёт системная кнопка «Назад»

/* Переходы вглубь: «Должен» → поставщик → закупка. «Назад» возвращает на прошлый экран и на то же место списка. */
const trail = [];        // { view, open, scroll }: экраны, с которых ушли вглубь
let here = null;         // как заново открыть текущий экран
let returning = null;    // запись trail, к которой идёт возврат; при свайпе он ещё может не состояться

function drill(open) {
  trail.push({ view: currentView, open: here, scroll: window.scrollY });
  return open();
}

function goBack() {
  const entry = trail[trail.length - 1];
  if (!entry || !entry.open) return showHome();
  returning = entry;
  return entry.open();
}

// Чеки разбирают подряд: после карточки список остаётся там, где был.
const restoredScroll = view => (returning && returning.view === view ? returning.scroll : 0);

// Значения полей экрана: по ним видно, ввёл ли человек что-то после открытия.
function snapshotView(view) {
  const fields = [...$('v-' + view).querySelectorAll('input:not([type="file"]), textarea, select')];
  return fields.filter(f => (f.type === 'radio' || f.type === 'checkbox' ? f.checked : f.value)).map(f => `${f.id || f.name}=${f.value}`).join('|');
}

// reopen — как открыть этот экран заново, когда на него вернутся «Назад».
function show(view, reopen = NAV[view]) {
  if (peek) {
    peek.view = view;
    peek.reopen = reopen;
    return;
  }
  const scrollTop = restoredScroll(view);
  if (returning && returning.view === view) trail.pop();
  returning = null;
  if (TABS.includes(view)) trail.length = 0;
  here = reopen;
  VIEWS.forEach(v => { $('v-' + v).hidden = v !== view; });
  currentView = view;
  viewSnapshot = snapshotView(view);
  leaveWarnedAt = 0;
  $('toast').hidden = true;
  $('tabbar').hidden = !TABS.includes(view);
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-current', String(t.dataset.go === view)));
  if (!PHOTO_VIEWS.includes(view)) releaseViewPhotos();
  window.scrollTo(0, scrollTop);
  if (view !== 'home') armSystemBack();
}

function armSystemBack() {
  if (!ANDROID || backArmed) return;
  history.pushState(null, '');
  backArmed = true;
}

async function showHome() {
  await renderHome();
  show('home');
}

const NAV = { home: showHome, report: () => showReport(), more: showMore, card: () => openCard(cardId), search: () => openSearch(), back: goBack };

// Строка списка с data-open="вид:id" открывает свою карточку, а «Назад» вернёт к списку.
const OPEN = {
  card: id => openCard(id),
  advance: id => openEntry('advance', id),
  return: id => openEntry('return', id),
  repayment: id => openEntry('repayment', id),
  supplier: id => openSupplier(id),
  period: id => showReport(id),
};

document.addEventListener('click', e => {
  const target = e.target.closest('[data-open]');
  if (!target) return;
  const [kind, id] = target.dataset.open.split(':');
  drill(() => OPEN[kind](Number(id)));
});

function hasUnsavedInput() {
  return viewSnapshot !== snapshotView(currentView) || (currentView === 'new' && form.photoJobs.length > 0);
}

const leaveGuarded = () => currentView !== 'search' && hasUnsavedInput() && Date.now() - leaveWarnedAt > LEAVE_CONFIRM_MS;

// Введённое не теряется от случайного нажатия или жеста: сначала предупреждение, выход только по второму разу.
function mustConfirmLeave(hint) {
  if (currentView === 'search' || !hasUnsavedInput()) return false;
  const since = Date.now() - leaveWarnedAt;
  if (since < DOUBLE_TAP_MS) return true;
  if (since <= LEAVE_CONFIRM_MS) return false;
  leaveWarnedAt = Date.now();
  toast(`Введённое не сохранено. ${hint}`);
  return true;
}

document.addEventListener('click', e => {
  const go = e.target.closest('[data-go]');
  if (!go || (go.classList.contains('back') && mustConfirmLeave('Нажмите «Назад» ещё раз, чтобы выйти.'))) return;
  NAV[go.dataset.go]();
});

/* Свайп: экран идёт за пальцем, соседний въезжает рядом. Вправо на внутреннем экране — это «Назад». */

const SWIPE_COMMIT_SHARE = 0.3;      // палец отпущен дальше этой доли экрана: переход состоится
const SWIPE_FLICK_SPEED = 0.35;      // либо быстрый взмах, пикселей в мс
const SWIPE_STALE_MS = 80;           // палец постоял перед отпусканием: это уже не взмах
const SWIPE_RESIST = 0.3;            // дальше листать некуда: экран лишь немного поддаётся
const SWIPE_SETTLE_MS = [140, 280];  // доезжает тем быстрее, чем быстрее был взмах
const SWIPE_SIDEWAYS_RATIO = 1.5;    // наклонное движение — это прокрутка страницы
// Здесь палец и так ходит вбок: ведут по графику, двигают курсор в поле.
const SWIPE_IGNORE = '.plot, input:not([type="radio"]):not([type="checkbox"]), textarea, select';
let swipeStart = null;
let drag = null;

// Таблица мешает свайпу, только если её действительно есть куда листать.
function scrollsSideways(target) {
  const box = target.closest('.scroll');
  return !!box && box.scrollWidth > box.clientWidth;
}

function swipeGoal(dir) {
  if (TABS.includes(currentView)) return TABS[TABS.indexOf(currentView) - dir] || null;
  if (dir < 0) return null;
  const back = $('v-' + currentView).querySelector('.back, [data-go]');
  return back ? back.dataset.go : null;
}

function paintDrag(d) {
  d.frame = 0;
  d.section.style.setProperty('--swipe-x', `${d.x}px`);
  const beside = `${d.x - d.dir * d.width}px`;
  if (d.target) d.target.style.setProperty('--swipe-x', beside);
  if (d.bar) d.bar.style.setProperty('--swipe-x', beside);
}

// Соседний экран заполняется заранее и стоит рядом с текущим. Прокрутка окна при этом не меняется.
async function prepareTarget(d) {
  peek = {};
  try {
    await NAV[d.go]();
    d.view = peek.view;
    d.reopen = peek.reopen;
  } catch (err) {
    console.error(err);
    return;
  } finally {
    peek = null;
  }
  d.target = $('v-' + d.view);
  d.target.style.left = `${d.box.left}px`;
  d.target.style.width = `${d.box.width}px`;
  d.target.style.top = `${d.box.top + window.scrollY - restoredScroll(d.view)}px`;
  d.target.style.position = 'fixed';
  d.target.classList.add('dragging');
  d.target.hidden = false;
  if (TABS.includes(d.view) && !TABS.includes(currentView)) {
    d.bar = $('tabbar');
    d.bar.classList.add('swipe-bar');
    d.bar.hidden = false;
  }
  paintDrag(d);
}

function beginDrag(dx) {
  const dir = Math.sign(dx);
  const section = $('v-' + currentView);
  let go = swipeGoal(dir);
  // Экран того же вида нельзя заранее поставить рядом: он один. Остаётся кнопка «Назад».
  if (go === 'back' && trail.length && trail[trail.length - 1].view === currentView) go = null;
  drag = {
    dir,
    section,
    go,
    guarded: !TABS.includes(currentView) && leaveGuarded(),
    box: section.getBoundingClientRect(),
    width: window.innerWidth,
    startX: swipeStart.x,
    lastX: swipeStart.x,
    lastAt: performance.now(),
    pull: 0,
    x: 0,
    speed: 0,
    frame: 0,
    released: false,
    view: null,
    reopen: null,
    target: null,
    bar: null,
    ready: Promise.resolve(),
  };
  section.classList.add('dragging');
  if (drag.go && !drag.guarded) drag.ready = prepareTarget(drag);
}

function moveDrag(d, clientX) {
  const now = performance.now();
  if (now > d.lastAt) d.speed = 0.7 * (clientX - d.lastX) / (now - d.lastAt) + 0.3 * d.speed;
  d.lastX = clientX;
  d.lastAt = now;
  d.pull = Math.max((clientX - d.startX) * d.dir, 0);
  const free = d.go && !d.guarded;
  d.x = d.dir * (free ? Math.min(d.pull, d.width) : d.pull * SWIPE_RESIST);
  if (!d.frame) d.frame = requestAnimationFrame(() => paintDrag(d));
}

function finishDrag(d, commit) {
  [d.section, d.target, d.bar].filter(Boolean).forEach(el => {
    el.classList.remove('dragging', 'settling', 'swipe-bar');
    el.style.removeProperty('--swipe-x');
  });
  if (d.target) {
    d.target.style.position = d.target.style.left = d.target.style.width = d.target.style.top = '';
    d.target.hidden = !commit;
  }
  drag = null;
  if (commit) show(d.view, d.reopen);
  else {
    returning = null;
    $('tabbar').hidden = !TABS.includes(currentView);
  }
}

async function releaseDrag(d, lifted) {
  d.released = true;
  cancelAnimationFrame(d.frame);
  await d.ready;
  if (performance.now() - d.lastAt > SWIPE_STALE_MS) d.speed = 0;
  const pulled = lifted && (d.pull > d.width * SWIPE_COMMIT_SHARE || d.speed * d.dir > SWIPE_FLICK_SPEED);
  if (pulled && d.guarded) mustConfirmLeave('Свайпните ещё раз, чтобы выйти.');
  const commit = pulled && !!d.view;
  const end = commit ? d.dir * d.width : 0;
  const [fastest, slowest] = SWIPE_SETTLE_MS;
  const ms = Math.round(Math.min(slowest, Math.max(fastest, Math.abs(end - d.x) / Math.max(Math.abs(d.speed), 0.01))));
  document.documentElement.style.setProperty('--swipe-ms', `${ms}ms`);
  [d.section, d.target, d.bar].filter(Boolean).forEach(el => el.classList.add('settling'));
  d.x = end;
  paintDrag(d);
  setTimeout(() => finishDrag(d, commit), ms + 20);
}

document.addEventListener('touchstart', e => {
  if (drag) {
    if (!drag.released) releaseDrag(drag, false);
    return;
  }
  swipeStart = null;
  if (e.touches.length !== 1 || e.target.closest(SWIPE_IGNORE) || scrollsSideways(e.target)) return;
  swipeStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });

// Не passive: направление решается по первому движению, и вбок страница не должна прокручиваться.
document.addEventListener('touchmove', e => {
  if (!swipeStart && !drag) return;
  const { clientX, clientY } = e.touches[0];
  if (!drag) {
    const dx = clientX - swipeStart.x;
    const sideways = e.cancelable && Math.abs(dx) > Math.abs(clientY - swipeStart.y) * SWIPE_SIDEWAYS_RATIO;
    if (sideways) beginDrag(dx);
    swipeStart = null;
    if (!sideways) return;
  }
  if (e.cancelable) e.preventDefault();
  if (!drag.released) moveDrag(drag, clientX);
}, { passive: false });

['touchend', 'touchcancel'].forEach(type => document.addEventListener(type, e => {
  swipeStart = null;
  if (drag && !drag.released) releaseDrag(drag, type === 'touchend');
}, { passive: true }));

// На Android системная кнопка «Назад» работает как «Назад» в приложении и не теряет введённое. На главной она закрывает его.
if (ANDROID) {
  history.scrollRestoration = 'manual';
  window.addEventListener('popstate', () => {
    backArmed = false;
    const go = swipeGoal(1);
    if (!go) {
      toast('Нажмите «Назад» ещё раз, чтобы выйти.');
      return;
    }
    if (drag || (!TABS.includes(currentView) && mustConfirmLeave('Нажмите «Назад» ещё раз, чтобы выйти.'))) {
      armSystemBack();
      return;
    }
    NAV[go]();
  });
}

// iOS держит приложение в памяти днями: дата в шапке не должна застывать.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('v-home').hidden) renderHome();
});

/* Главная */

const methodTag = method => `<span class="tag adv">${method === 'cash' ? 'нал' : 'перевод'}</span>`;

function renderOperation({ kind, x }) {
  if (kind === 'advance') {
    return `<button class="item" type="button" data-open="advance:${x.id}"><span class="no">${dShort(x.date)}</span><span class="body"><span class="t">Выдача аванса${methodTag(x.method)}</span><span class="s">${esc(x.by)}</span></span><span class="a good">+${money(x.amount)}</span></button>`;
  }
  if (kind === 'return') {
    return `<button class="item" type="button" data-open="return:${x.id}"><span class="no">${dShort(x.dt)}</span><span class="body"><span class="t">Возврат денег${methodTag(x.method)}</span><span class="s">${esc(x.to)}</span></span><span class="a">−${money(x.amount)}</span></button>`;
  }
  if (kind === 'repayment') {
    return `<button class="item" type="button" data-open="repayment:${x.id}"><span class="no">${dShort(x.dt)}</span><span class="body"><span class="t">Погашение долга${methodTag(x.method)}</span><span class="s">${esc(x.supplierName)}${x.no ? ` · за №${pad3(x.no)}` : ''}</span></span><span class="a">−${money(x.amount)}</span></button>`;
  }
  const storno = x.status === 'storno';
  const noDoc = x.docType === 'none';
  // Метки идут первыми: длинное имя поставщика не должно вытеснять их за многоточие.
  const tags = (x.type === 'service' ? '<span class="tag adv">услуга</span>' : '') +
    (storno ? '<span class="tag bad">сторно</span>' : noDoc ? '<span class="tag warn">нет документа</span>' : '') +
    (debtOf(x) ? '<span class="tag warn">в долг</span>' : '');
  const doc = storno || noDoc ? '' : ` · ${DOC[x.docType]}`;
  const noItems = x.noItems ? '<br><span class="tag warn">без позиций</span>' : '';
  return `<button class="item${storno ? ' storno' : ''}" type="button" data-open="card:${x.id}"><span class="no">№${pad3(x.no)}<br>${dShort(x.dt)}</span><span class="body"><span class="t">${esc(purchaseTitle(x) || x.supplierName)}</span><span class="s">${tags}${tags ? ' ' : ''}${esc(x.supplierName)}${doc}</span></span><span class="a">−${money(x.amount)}${noItems}</span></button>`;
}

const supplierNames = async () => new Map((await db.suppliers.toArray()).map(s => [s.id, s.name]));

// Строки списка операций: закупки с именем поставщика, погашения — с закупкой, за которую заплачено.
async function purchaseOps(purchases, extra = () => ({})) {
  const names = await supplierNames();
  return purchases.map(p => ({ kind: 'purchase', at: p.dt, x: { ...p, supplierName: names.get(p.supplierId), ...extra(p) } }));
}

async function repaymentOps(repayments) {
  const [names, purchases] = await Promise.all([supplierNames(), db.purchases.bulkGet([...new Set(repayments.map(r => r.purchaseId))])]);
  const byId = new Map(purchases.filter(Boolean).map(p => [p.id, p]));
  return repayments.map(r => {
    const p = byId.get(r.purchaseId);
    return { kind: 'repayment', at: r.dt, x: { ...r, no: p ? p.no : 0, supplierName: p ? names.get(p.supplierId) : 'Закупка в архиве' } };
  });
}

const advanceOps = advances => advances.map(a => ({ kind: 'advance', at: a.date + 'T00:00', x: a }));
const returnOps = returns => returns.map(r => ({ kind: 'return', at: r.dt, x: r }));
const sortOps = ops => ops.sort((a, b) => b.at.localeCompare(a.at) || b.x.id - a.x.id);

let homeNoItems = false;   // на главной показаны только закупки без позиций
let homePeriodId = null;   // период плашки: её цифры раскрываются списками

// Цифры плашки нажимаются: за каждой — список записей, из которых она сложилась.
function renderPlate(sum, debt) {
  const cell = (key, label, value, cls = '') =>
    `<button type="button" data-sum="${key}"><span class="label">${label}<span class="chev">›</span></span><b class="${cls}">${money(value)}</b></button>`;
  const cells = [
    cell('issued', 'Выдано', sum.issued),
    cell('spent', 'Израсходовано', sum.spent),
    ...(sum.returned ? [cell('returned', 'Возвращено', sum.returned)] : []),
    cell('debts', 'Должен', debt, debt ? 'debt' : ''),
  ];
  $('h-meta').innerHTML = cells.join('');
}

async function renderHome() {
  const period = await getCurrentPeriod();
  const closed = !!period && period.status === 'closed';
  const sum = await periodSummary(period);
  const debts = await getDebts();
  homePeriodId = period ? period.id : null;

  $('h-org').textContent = await getSetting('org');
  $('h-date').textContent = dFull(nowLocal());
  $('h-period').textContent = period ? period.number + (closed ? ' · закрыт' : '') : 'Период не открыт';
  $('b-newp').hidden = !closed;
  $('h-actions').hidden = closed;
  $('h-bal').innerHTML = `${money(sum.balance)}<small>сом</small><span class="chev">›</span>`;
  $('h-bal').classList.toggle('neg', sum.balance < 0);
  renderPlate(sum, sumLeft(debts));

  const notes = [];
  if (closed) notes.push(`<div class="note warn"><span>Период закрыт ${dFull(period.closed)}. Возврат в кассу: <b class="num">${money(sum.returned)} сом</b>.${sum.balance > 0 ? ` На руках осталось <b class="num">${money(sum.balance)} сом</b>, в новый период этот остаток не перейдёт.` : ''}</span></div>`);
  if (sum.balance < 0) notes.push(`<div class="note bad"><span>Перерасход <b class="num">${money(-sum.balance)} сом</b>. Будет отражён в отчёте отдельной строкой.</span></div>`);
  if (sum.noDoc > 0) notes.push(`<div class="note warn"><span>Без документов: <b class="num">${money(sum.noDoc)} сом</b>. Бухгалтерия может не принять эти расходы.</span></div>`);
  const reminder = await backupReminder();
  if (reminder) notes.push(`<div class="note info"><span>${reminder.never ? `Бэкапа ещё не было, закупок: ${reminder.count}` : `Последний бэкап ${reminder.days} дн. назад, закупок с тех пор: ${reminder.count}`}. Данные хранятся только на этом телефоне.</span></div><button class="btn full" type="button" id="h-backup">Сохранить копию</button>`);
  $('h-notes').innerHTML = notes.join('');
  if (reminder) $('h-backup').onclick = e => runBackup(e.currentTarget, renderHome);

  // После закрытия позиции внести нельзя, поэтому метка нужна только в открытом периоде.
  const needsItems = p => !closed && p.status === 'active' && !p.items.length;
  const noItemsCount = sum.purchases.filter(needsItems).length;
  if (!noItemsCount) homeNoItems = false;
  const operations = sortOps([
    ...await purchaseOps(sum.purchases.filter(p => !homeNoItems || needsItems(p)), p => ({ noItems: needsItems(p) })),
    ...(homeNoItems ? [] : [...advanceOps(sum.advances), ...returnOps(sum.returns), ...await repaymentOps(sum.repayments)]),
  ]);

  $('h-count').textContent = `${sum.count} ${plural(sum.count, 'закупка', 'закупки', 'закупок')}`;
  $('h-filter').hidden = !noItemsCount;
  $('h-filter').textContent = homeNoItems ? 'Показать все операции' : `Показать без позиций: ${noItemsCount}`;
  $('h-list').innerHTML = operations.length
    ? operations.map(renderOperation).join('')
    : '<div class="empty">Операций пока нет. Начните с выдачи аванса.</div>';
}

$('h-filter').onclick = () => {
  homeNoItems = !homeNoItems;
  renderHome();
};
$('b-new').onclick = () => openNew();
$('b-adv').onclick = () => openAdvance('advance');
$('b-ret').onclick = () => openAdvance('return');
$('h-meta').addEventListener('click', e => {
  const b = e.target.closest('[data-sum]');
  if (b) drill(() => openList(SUM_LISTS[b.dataset.sum](homePeriodId)));
});
// Остаток раскрывается расчётом: из чего он сложился, по строкам.
$('h-bal').onclick = () => {
  if (!homePeriodId) return;
  reportView = 'sum';
  showReport(homePeriodId);
};
$('b-newp').onclick = async () => {
  await openNewPeriod();
  await showHome();
  toast('Открыт новый период. Добавьте выдачу аванса.');
};

/* Новая закупка */

const form = {
  balance: 0,
  suppliers: [],
  bazaars: [],
  history: [],        // действующие закупки, новые первыми: источник подсказок
  lastSaved: null,    // для кнопки «Ещё у этого поставщика»
  touched: {},        // поля, выбранные вручную: подстановка их не трогает
  autoPhone: '',      // телефон, подставленный от поставщика: при смене имени он снимается
  dateRange: null,    // [от, до] для даты закупки в режиме правки
  editing: null,      // закупка в режиме правки, null для новой
  repaid: 0,          // сколько уже погашено по закупке в правке: долг не может стать меньше
  session: {},        // новая форма — новый объект: по нему отсекается фото, дожатое для прошлой формы
  receipts: [],       // [{ blob, url }]
  goods: [],          // [{ blob, url }]
  supplierShots: [],  // [{ blob, url }]
  knownUrls: [],      // прошлые снимки выбранного поставщика
  photoJobs: [],
  noDocArmedAt: 0,
  saving: false,
};

// Снимки формы: одинаковые ряды для чеков, товара и поставщика.
const FORM_PHOTOS = {
  receipt: { list: 'receipts', box: 'f-photo-list', title: 'f-photo-title', alt: 'Фото чека' },
  goods: { list: 'goods', box: 'f-goods-list', title: 'f-goods-title', alt: 'Фото товара' },
  supplier: { list: 'supplierShots', box: 'f-sp-list', title: 'f-sp-title', alt: 'Фото поставщика' },
};

const KNOWN_SHOTS = 3;   // столько прошлых снимков поставщика видно в форме

function renderPhotos(kind) {
  const { list, box, title, alt } = FORM_PHOTOS[kind];
  $(box).innerHTML = form[list].map((p, i) =>
    `<span class="thumb"><img src="${p.url}" alt="${alt} ${i + 1}"><button type="button" data-del-photo="${kind}" data-index="${i}" aria-label="Удалить: ${alt} ${i + 1}"><span>×</span></button></span>`
  ).join('');
  const service = radioVal('type') === 'service';
  const empty = {
    receipt: 'Сфотографировать чек',
    goods: service ? 'Сделать фото' : 'Сфотографировать товар',
    supplier: service ? 'Сфотографировать исполнителя' : 'Сфотографировать поставщика',
  }[kind];
  $(title).textContent = form[list].length ? 'Добавить ещё фото' : empty;
}

function clearPhotos() {
  [...form.receipts, ...form.goods, ...form.supplierShots].forEach(p => URL.revokeObjectURL(p.url));
  form.receipts = [];
  form.goods = [];
  form.supplierShots = [];
  renderPhotos('receipt');
  renderPhotos('goods');
  renderPhotos('supplier');
  showKnownShots([]);
}

function showKnownShots(shots) {
  form.knownUrls.forEach(url => URL.revokeObjectURL(url));
  form.knownUrls = shots.slice(0, KNOWN_SHOTS).map(shot => URL.createObjectURL(shot.blob));
  $('f-sp-known').innerHTML = form.knownUrls.map(url => `<button class="shot" type="button" aria-label="Увеличить снимок"><img src="${url}" alt="Прошлый снимок поставщика"></button>`).join('');
  $('f-sp-known-hint').hidden = !shots.length;
}

// По прошлым снимкам вспоминают, какой это был контейнер.
async function updateKnownShots() {
  const name = () => $('f-supplier').value.trim().toLowerCase();
  const query = name();
  const known = !form.editing && form.suppliers.find(s => s.name.toLowerCase() === query);
  const shots = known ? await getSupplierPhotos(known.id) : [];
  if (query === name()) showKnownShots(shots);
}

$('f-sp-known').addEventListener('click', e => {
  const shot = e.target.closest('.shot');
  if (shot) shot.classList.toggle('wide');
});

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
  $('f-sp-label').textContent = service ? 'Фото исполнителя' : 'Фото поставщика';
  $('f-place-field').hidden = service;
  renderPhotos('goods');
  renderPhotos('supplier');
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
  form.autoPhone = '';
  form.session = {};
  form.photoJobs = [];
  clearPhotos();
  resetNoDocConfirm();

  $('n-title').textContent = editing ? 'Правка закупки' : 'Новая закупка';
  $('n-no').textContent = '№' + pad3(no);
  $('f-back').dataset.go = editing ? 'card' : 'home';
  $('f-receipt-block').hidden = !!editing;
  $('f-goods-field').hidden = !!editing;
  $('f-sp-field').hidden = !!editing;
  $('f-date-field').hidden = !editing;
  const itemized = !!editing && editing.items.length > 0;
  $('f-amount').readOnly = itemized;
  $('f-amount-hint').hidden = !itemized;
  ['f-name', 'f-amount', 'f-paid', 'f-supplier', 'f-phone', 'f-comment', 'f-date'].forEach(id => { $(id).value = ''; });
  $('f-place-new').hidden = true;
  $('f-place-add').hidden = false;
  renderPlaces(place);
  chips($('f-type'), 'type', Object.entries(TYPES), type);
  applyPurchaseType();
  chips($('f-doc'), 'doc', Object.entries(DOC), docType, 'none');
  chips($('f-pay'), 'pay', Object.entries(PAY), payment, 'debt');
  applyPayment();
}

// prefill — кнопки «Ещё у этого поставщика» и «Повторить закупку»: остаётся ввести только сумму.
async function openNew(prefill = null) {
  form.repaid = 0;
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
    // В долг берут по договорённости, а не по привычке: это выбирают каждый раз сами.
    payment: last && last.payment !== 'debt' ? last.payment : 'cash',
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
  const period = await db.periods.get(x.periodId);
  const [sum, bazaars, suppliers, supplier, history, repaid] = await Promise.all([
    periodSummary(period),
    db.bazaars.toArray(),
    db.suppliers.toArray(),
    db.suppliers.get(x.supplierId),
    getRecentPurchases(),
    repaidFor(id),
  ]);
  form.repaid = repaid;
  fillForm({
    editing: x,
    no: x.no,
    balance: sum.balance + x.amount - debtOf(x),
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
  if (x.payment === 'debt') $('f-paid').value = x.paidNow ? money(x.paidNow) : '';
  $('f-supplier').value = supplier.name;
  $('f-phone').value = supplier.phone;
  form.autoPhone = supplier.phone;
  $('f-comment').value = x.comment;
  // Номер уникален в пределах года, поэтому дата не выходит за год закупки. Расходы начинаются с открытия периода.
  const yearStart = `${x.year}-01-01`;
  const yearEnd = `${x.year}-12-31`;
  const today = nowLocal().slice(0, 10);
  form.dateRange = [period.opened > yearStart ? period.opened : yearStart, today < yearEnd ? today : yearEnd];
  [$('f-date').min, $('f-date').max] = form.dateRange;
  $('f-date').value = x.dt.slice(0, 10);
  updateSuggestions();
  applyPayment();
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

function takePickedFiles(input) {
  const files = [...(input.files || [])];
  input.value = '';
  return files;
}

// Снимки сжимаются по одному: несколько полных кадров сразу iPhone может не потянуть по памяти.
function queuePhotos(kind, files) {
  const { session } = form;
  const previous = form.photoJobs[form.photoJobs.length - 1] || Promise.resolve();
  form.photoJobs.push(previous.then(async () => {
    for (const file of files) {
      let blob;
      try {
        blob = await compressPhoto(file);
      } catch {
        toast('Не удалось открыть фото. Попробуйте снять ещё раз.');
        continue;
      }
      if (form.session !== session) return;
      form[FORM_PHOTOS[kind].list].push({ blob, url: URL.createObjectURL(blob) });
      renderPhotos(kind);
    }
  }));
}

[['f-photo', 'receipt'], ['f-photo-lib', 'receipt'], ['f-goods', 'goods'], ['f-goods-lib', 'goods'], ['f-sp', 'supplier'], ['f-sp-lib', 'supplier']].forEach(([id, kind]) => {
  $(id).addEventListener('change', e => {
    const files = takePickedFiles(e.target);
    if (files.length) queuePhotos(kind, files);
  });
});

['f-photo-list', 'f-goods-list', 'f-sp-list'].forEach(id => $(id).addEventListener('click', e => {
  const b = e.target.closest('[data-del-photo]');
  if (!b) return;
  const { delPhoto: kind, index } = b.dataset;
  const [removed] = form[FORM_PHOTOS[kind].list].splice(Number(index), 1);
  URL.revokeObjectURL(removed.url);
  renderPhotos(kind);
}));

// Из аванса уходит только оплаченное сразу. Пустое поле — всё в долг.
function formPaidNow() {
  if (radioVal('pay') !== 'debt') return parseMoney($('f-amount').value) || 0;
  return parseMoney($('f-paid').value) || 0;
}

function updateOverspendNote() {
  const amount = parseMoney($('f-amount').value) || 0;
  const over = formPaidNow() - form.balance;
  $('f-over').innerHTML = amount > 0 && over > 0
    ? `<div class="note bad"><span>${radioVal('pay') === 'debt' ? 'Оплаченное сразу' : 'Сумма'} больше остатка. Перерасход составит <b class="num">${money(over)} сом</b>, сохранить можно.</span></div>`
    : '';
  const debt = amount - formPaidNow();
  $('f-debt-hint').textContent = amount && debt > 0
    ? `Долг поставщику: ${money(debt)} сом. В остаток аванса он не входит, погасить можно позже из карточки или со страницы поставщика.`
    : 'Остальное будет долгом поставщику. В остаток аванса он не входит.';
}

function applyPayment() {
  $('f-paid-field').hidden = radioVal('pay') !== 'debt';
  updateOverspendNote();
}

$('f-amount').addEventListener('input', updateOverspendNote);
$('f-paid').addEventListener('input', updateOverspendNote);
$('f-pay').addEventListener('change', applyPayment);

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
  if (!$('f-phone').value && known.phone) {
    $('f-phone').value = known.phone;
    form.autoPhone = known.phone;
  }
  const last = form.history.find(p => p.supplierId === known.id && typeOf(p) === radioVal('type'));
  const place = (last && last.place) || known.place;
  if (place && !form.touched.place) renderPlaces(place);
  if (!last || form.editing) return;
  const doc = radioVal('doc');
  if (!form.touched.doc) setRadio('doc', last.docType);
  if (!form.touched.pay && last.payment !== 'debt') setRadio('pay', last.payment);
  if (radioVal('doc') !== doc) resetNoDocConfirm();
  applyPayment();
}

// Телефон прошлого поставщика не должен достаться новому. Введённый вручную остаётся.
function dropAutoPhone() {
  if (form.autoPhone && $('f-phone').value === form.autoPhone) $('f-phone').value = '';
  form.autoPhone = '';
}

function pickSupplier(name) {
  dropAutoPhone();
  $('f-supplier').value = name;
  applySupplierDefaults(name);
  updateSuggestions();
  updateKnownShots();
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
$('f-supplier').addEventListener('input', () => {
  dropAutoPhone();
  updateSuggestions();
  updateKnownShots();
});
// Не на каждую букву: «ИП Асанов» может оказаться началом имени другого поставщика.
$('f-supplier').addEventListener('change', e => applySupplierDefaults(e.target.value));
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

// Подстановка срабатывает при уходе из поля, то есть уже во время нажатия на «Сохранить».
// Если в этот момент перезаписать кнопку, WebKit отменяет клик, поэтому лишних записей нет.
function resetNoDocConfirm() {
  form.noDocArmedAt = 0;
  const button = $('f-save');
  const label = form.editing ? 'Сохранить изменения' : 'Сохранить закупку';
  if (button.textContent !== label) button.textContent = label;
  if (button.className !== 'btn primary full') button.className = 'btn primary full';
  if ($('f-warn').innerHTML) $('f-warn').innerHTML = '';
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
  const payment = radioVal('pay');
  const paidNow = payment === 'debt' ? parseMoney($('f-paid').value || '0') : 0;
  if (paidNow === null) { toast('Введите, сколько оплачено сразу, или оставьте поле пустым.'); $('f-paid').focus(); return; }
  if (payment === 'debt' && paidNow >= amount) {
    toast('Оплачено всё: выберите «Наличные» или «Перевод».');
    $('f-paid').focus();
    return;
  }
  // Сумма с позициями в правке не меняется, долг считается от неё.
  const finalAmount = form.editing && form.editing.items.length ? form.editing.amount : amount;
  if (form.repaid && (payment !== 'debt' || finalAmount - paidNow < form.repaid)) {
    toast(`По этой закупке уже погашено ${money(form.repaid)} сом: долг не может быть меньше. Сначала удалите лишние погашения.`, 6000);
    return;
  }
  const date = $('f-date').value;
  if (form.editing && (!date || date < form.dateRange[0] || date > form.dateRange[1])) {
    toast(`Дата должна быть от ${dFull(form.dateRange[0])} до ${dFull(form.dateRange[1])}.`);
    $('f-date').focus();
    return;
  }
  if (docType === 'none' && !(form.editing && form.editing.docType === 'none')) {
    if (!form.noDocArmedAt) { armNoDocConfirm(); return; }
    // Двойной тап не должен сойти за осознанное второе нажатие.
    if (Date.now() - form.noDocArmedAt < DOUBLE_TAP_MS) return;
  }

  const data = {
    type,
    goodsName,
    amount,
    paidNow,
    supplierName,
    phone: $('f-phone').value.trim(),
    place: service ? '' : radioVal('place') || '',
    docType,
    payment,
    comment: $('f-comment').value.trim(),
  };

  form.saving = true;
  $('f-save').disabled = true;
  let saved;
  try {
    if (form.editing) {
      await updatePurchase(form.editing.id, { ...data, date });
    } else {
      await Promise.all(form.photoJobs);
      const photos = [
        ...form.receipts.map(p => ({ kind: 'receipt', blob: p.blob })),
        ...form.goods.map(p => ({ kind: 'goods', blob: p.blob })),
        ...form.supplierShots.map(p => ({ kind: 'supplier', blob: p.blob })),
      ];
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
  const debt = payment === 'debt' ? amount - paidNow : 0;
  $('d-sum').innerHTML = `<span class="num">${money(amount)}</span> сом · ${esc(supplierName)}` +
    (debt ? `<br>В долг: <span class="num">${money(debt)}</span> сом` : '') +
    `<br>Остаток: <span class="num">${money(balance)}</span> сом${balance < 0 ? ' (перерасход)' : ''}`;
  show('done');
}

$('f-save').onclick = submitPurchase;
$('d-more').onclick = () => openNew();
$('d-same').onclick = () => openNew(form.lastSaved);

/* Журнал */

const AUDIT_FIELDS = {
  type: 'Тип', goodsName: 'Наименование', dt: 'Дата', amount: 'Сумма', supplierId: 'Поставщик', place: 'Базар', purposeId: 'Назначение', docType: 'Документ',
  payment: 'Оплата', paidNow: 'Оплачено сразу', comment: 'Комментарий', items: 'Позиции', status: 'Статус', stornoReason: 'Причина сторно',
  name: 'Название', phone: 'Телефон', archived: 'В архиве', active: 'Действует',
  photoAdded: 'Добавлено фото', photoDeleted: 'Удалено фото', deleted: 'Удалена запись', toArchive: 'В архив', fromArchive: 'Из архива',
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
    case 'amount': case 'ret': case 'paidNow': return `${money(value)} сом`;
    case 'closed': case 'dt': return dFull(value);
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
  if (e.entity === 'return') return 'Возврат денег';
  if (e.entity === 'repayment') return 'Погашение долга';
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
let viewPhotoUrls = [];
let stornoSaving = false;

function viewPhotoUrl(blob) {
  const url = URL.createObjectURL(blob);
  viewPhotoUrls.push(url);
  return url;
}

function releaseViewPhotos() {
  // Свайп ещё могут отменить, и тогда текущий экран останется со своими фото.
  if (peek) return;
  viewPhotoUrls.forEach(url => URL.revokeObjectURL(url));
  viewPhotoUrls = [];
}

function renderItemsTable(x) {
  const rows = x.items.map(i =>
    `<tr><td>${esc(i.name)}</td><td class="r">${String(i.qty).replace('.', ',')}</td><td>${esc(i.unit)}</td><td class="r">${money(i.price)}</td><td class="r">${money(i.sum)}</td></tr>`
  ).join('');
  return `<div class="scroll"><table class="items-table"><thead><tr><th>Товар</th><th class="r">Кол-во</th><th>Ед.</th><th class="r">Цена</th><th class="r">Сумма</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td colspan="4">Итого</td><td class="r">${money(x.amount)}</td></tr></tfoot></table></div>`;
}

// next — следующая закупка без позиций, чтобы разбирать чеки подряд: { purchase, left }.
async function openCard(id, next = null) {
  cardId = id;
  const x = await db.purchases.get(id);
  const [supplier, period, photos, history, ctx, repayments] = await Promise.all([
    db.suppliers.get(x.supplierId),
    db.periods.get(x.periodId),
    db.photos.where('purchaseId').equals(id).toArray(),
    db.auditLog.where('entityId').equals(id).filter(e => e.entity === 'purchase').toArray(),
    auditContext(),
    db.repayments.where('purchaseId').equals(id).toArray(),
  ]);
  releaseViewPhotos();
  const shots = photos.map(p => ({ id: p.id, kind: p.kind, url: viewPhotoUrl(p.blob) }));
  const receipts = shots.filter(p => p.kind === 'receipt');
  const goods = shots.filter(p => p.kind === 'goods');
  const supplierShots = shots.filter(p => p.kind === 'supplier');
  const storno = x.status === 'storno';
  const editable = !storno && period.status === 'open';
  const service = x.type === 'service';
  // Деньги за закупку уже у поставщика: сторно и удаление только после удаления погашений.
  const locked = repayments.length > 0;

  const row = (dt, dd) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`;
  const badge = storno ? '<span class="tag bad">сторно</span>' : x.docType === 'none' ? '<span class="tag warn">нет документа</span>' : debtOf(x) ? '<span class="tag warn">в долг</span>' : '';
  $('c-title').innerHTML = `Закупка <span class="num">№${pad3(x.no)}</span>`;
  $('c-body').innerHTML =
    (next ? `<button class="btn primary full" type="button" id="c-next">Следующая без позиций: №${pad3(next.purchase.no)} (осталось ${next.left})</button>` : '') +
    `<div class="row"><span class="amount-hero${storno ? ' muted struck' : ''}">${money(x.amount)} сом</span><span class="spacer"></span>${badge}</div>` +
    (storno ? `<div class="note bad"><span><b>Сторнирована.</b> ${esc(x.stornoReason)}</span></div>` : '') +
    '<dl class="kv">' +
    row('Дата', `<span class="tnum">${dFull(x.dt)}, ${x.dt.slice(11, 16)}</span>`) +
    (purchaseTitle(x) ? row(service ? 'Услуга' : 'Товар', esc(purchaseTitle(x))) : '') +
    linkRow(service ? 'Исполнитель' : 'Поставщик', esc(supplier.name), `supplier:${supplier.id}`) +
    (supplier.phone ? row('Телефон', telLink(supplier.phone)) : '') +
    (x.place ? row('Базар', esc(x.place)) : '') +
    row('Документ', DOC[x.docType]) +
    row('Оплата', PAY[x.payment]) +
    linkRow('Период', esc(period.number), `period:${period.id}`) +
    (x.comment ? row('Комментарий', esc(x.comment)) : '') +
    '</dl>' +
    (editable ? '<div class="btn-row"><button class="btn primary" type="button" id="c-items">Позиции</button><button class="btn" type="button" id="c-edit">Изменить</button></div><button class="btn full" type="button" id="c-repeat">Повторить закупку</button>' : '') +
    (debtOf(x) ? await renderDebtBlock(x, repayments) : '') +
    '<div class="section-h"><h3>Позиции</h3></div>' +
    (x.items.length ? renderItemsTable(x) : '<div class="ph-none"><span>Позиции не внесены.</span></div>') +
    '<div class="section-h"><h3>Фото документа</h3></div>' +
    (receipts.length
      ? receipts.map(p => shotHtml(p, `Фото документа №${pad3(x.no)}`, editable)).join('')
      : `<div class="ph-none"><span>Фото не прикреплено. На бумажном документе должен стоять номер <b class="num">№${pad3(x.no)}</b>.</span></div>`) +
    (editable ? '<label class="btn full" for="c-add-receipt">Добавить фото чека</label><input class="file-input" type="file" id="c-add-receipt" accept="image/*" multiple tabindex="-1" aria-label="Добавить фото чека">' : '') +
    (goods.length || editable ? `<div class="section-h"><h3>${service ? 'Фото' : 'Фото товара'}</h3></div>` : '') +
    goods.map(p => shotHtml(p, `Фото товара №${pad3(x.no)}`, editable)).join('') +
    (editable ? `<label class="btn full" for="c-add-goods">${service ? 'Добавить фото' : 'Добавить фото товара'}</label><input class="file-input" type="file" id="c-add-goods" accept="image/*" multiple tabindex="-1" aria-label="Добавить фото товара">` : '') +
    (supplierShots.length || editable ? `<div class="section-h"><h3>${service ? 'Фото исполнителя' : 'Фото поставщика'}</h3></div>` : '') +
    supplierShots.map(p => shotHtml(p, `Фото поставщика, закупка №${pad3(x.no)}`, editable)).join('') +
    (editable ? `<label class="btn full" for="c-add-supplier">${service ? 'Добавить фото исполнителя' : 'Добавить фото поставщика'}</label><input class="file-input" type="file" id="c-add-supplier" accept="image/*" multiple tabindex="-1" aria-label="Добавить фото поставщика">` : '') +
    (history.length
      ? `<div class="section-h"><h3>История изменений</h3></div><div class="list">${history.map(e => renderAudit(e, ctx, false)).join('')}</div>`
      : '') +
    (locked && period.status === 'open' ? '<p class="muted hint">По закупке есть погашения долга. Чтобы сторнировать или удалить её, сначала удалите погашения.</p>' : '') +
    (editable && !locked ? '<div id="c-storno" class="stack"><button class="btn danger full" type="button" id="c-st-open">Сторнировать</button></div>' : '') +
    (period.status !== 'open' ? '<p class="muted hint">Чтобы изменить или удалить запись закрытого периода, сначала переоткройте его в Отчёте.</p>' : locked ? '' : '<button class="btn danger full" type="button" id="c-delete"></button>');
  const repay = $('c-repay');
  if (repay) repay.onclick = () => drill(() => openRepay([id]));
  if (editable) {
    $('c-items').onclick = () => openItems(id);
    $('c-edit').onclick = () => openEdit(id);
    $('c-repeat').onclick = () => openNew({ type: x.type, goodsName: x.goodsName, supplierName: supplier.name });
    if (!locked) $('c-st-open').onclick = () => openStorno(x);
    $('c-add-receipt').onchange = e => addCardPhotos(id, 'receipt', e.target);
    $('c-add-goods').onchange = e => addCardPhotos(id, 'goods', e.target);
    $('c-add-supplier').onchange = e => addCardPhotos(id, 'supplier', e.target);
    $('c-body').querySelectorAll('[data-del-shot]').forEach(b => {
      confirmTwice(b, 'Удалить это фото', 'Нажмите ещё раз: удалить фото', async () => {
        await deletePhoto(Number(b.dataset.delShot));
        await refreshCard(id);
        toast('Фото удалено');
      }, 'linkbtn bad');
    });
  }
  if (next) {
    $('c-next').onclick = () => {
      cardId = next.purchase.id;
      openItems(next.purchase.id);
    };
  }
  if (period.status === 'open' && !locked) {
    confirmTwice($('c-delete'), 'Удалить запись', `Нажмите ещё раз: удалить №${pad3(x.no)} насовсем`, async () => {
      await deletePurchase(id);
      await goBack();
      toast(`Закупка №${pad3(x.no)} удалена. Этот номер больше не выдаётся.`);
    });
  }
  show('card', () => openCard(id));
}

// Строка карточки, которая открывает связанный экран.
const linkRow = (dt, dd, open) => `<div class="link" role="button" tabindex="0" data-open="${open}"><dt>${dt}</dt><dd>${dd}<span class="chev">›</span></dd></div>`;
const telLink = phone => `<a href="tel:${esc(phone.replace(/[^\d+]/g, ''))}">${esc(phone)}</a>`;

// Сколько взято в долг, сколько отдано и чем. Погасить можно и в закрытом периоде закупки: деньги идут из текущего.
async function renderDebtBlock(x, repayments) {
  const repaid = sumAmounts(repayments);
  const left = debtOf(x) - repaid;
  const line = (label, value, cls = '') => `<div class="${cls}"><span>${label}</span><span class="v">${money(value)}</span></div>`;
  return '<div class="section-h"><h3>Долг поставщику</h3></div>' +
    '<div class="sum">' +
    line('Взято в долг', debtOf(x)) +
    (x.paidNow ? line('Оплачено сразу', x.paidNow) : '') +
    line('Погашено', repaid) +
    line(left ? 'Осталось отдать' : 'Долг погашен', left, 'total') +
    '</div>' +
    (repayments.length ? `<div class="list">${sortOps(await repaymentOps(repayments)).map(renderOperation).join('')}</div>` : '') +
    (left > 0 ? '<button class="btn primary full" type="button" id="c-repay">Погасить долг</button>' : '');
}

function shotHtml(shot, alt, editable) {
  const remove = editable ? `<button class="linkbtn bad" type="button" data-del-shot="${shot.id}"></button>` : '';
  return `<img class="photo-full" src="${shot.url}" alt="${alt}">${remove}`;
}

// Сжатие занимает время: человек мог уже уйти с этой карточки.
async function refreshCard(id) {
  if (currentView !== 'card' || cardId !== id) return;
  const y = window.scrollY;
  await openCard(id);
  window.scrollTo(0, y);
}

async function addCardPhotos(id, kind, input) {
  const files = takePickedFiles(input);
  if (!files.length) return;
  const blobs = [];
  for (const file of files) {
    try {
      blobs.push(await compressPhoto(file));
    } catch {
      toast('Не удалось открыть фото. Попробуйте снять ещё раз.');
    }
  }
  if (!blobs.length) return;
  try {
    await addPhotos(id, kind, blobs);
  } catch (err) {
    console.error(err);
    toast('Фото не сохранилось. Попробуйте ещё раз.');
    return;
  }
  await refreshCard(id);
  toast(blobs.length > 1 ? `Добавлено фото: ${blobs.length}` : 'Фото добавлено');
}

/* Выдача, возврат и погашение: короткая карточка с удалением, пока период открыт */

const ENTRY = {
  advance: { table: () => db.advances, title: 'Выдача аванса', what: 'выдачу', remove: deleteAdvance, done: 'Выдача удалена' },
  return: { table: () => db.returns, title: 'Возврат денег', what: 'возврат', remove: deleteReturn, done: 'Возврат удалён' },
  repayment: { table: () => db.repayments, title: 'Погашение долга', what: 'погашение', remove: deleteRepayment, done: 'Погашение удалено, долг снова числится' },
};

async function openEntry(kind, id) {
  const spec = ENTRY[kind];
  const x = await spec.table().get(id);
  const period = await db.periods.get(x.periodId);
  const row = (dt, dd) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`;
  let rows = '';
  if (kind === 'advance') rows = row('Дата', dFull(x.date)) + row('Способ', ADV_METHOD[x.method]) + row('Кто выдал', esc(x.by));
  if (kind === 'return') rows = row('Дата', dFull(x.dt)) + row('Способ', MONEY_METHOD[x.method]) + row('Кому', esc(x.to));
  if (kind === 'repayment') {
    const purchase = await db.purchases.get(x.purchaseId);
    const supplier = purchase && await db.suppliers.get(purchase.supplierId);
    rows = row('Дата', dFull(x.dt)) + row('Способ', MONEY_METHOD[x.method]) +
      (purchase
        ? linkRow('Поставщик', esc(supplier.name), `supplier:${supplier.id}`) + linkRow('За закупку', `№${pad3(purchase.no)} от ${dFull(purchase.dt)}`, `card:${purchase.id}`)
        : row('За закупку', 'убрана в архив'));
  }
  $('e-title').textContent = spec.title;
  $('e-body').innerHTML =
    `<div class="row"><span class="amount-hero">${money(x.amount)} сом</span></div>` +
    '<dl class="kv">' + rows +
    linkRow('Период', esc(period.number), `period:${period.id}`) +
    (x.comment ? row('Комментарий', esc(x.comment)) : '') +
    '</dl>' +
    (period.status === 'open' ? '<button class="btn danger full" type="button" id="e-delete"></button>' : '');
  if (period.status === 'open') {
    confirmTwice($('e-delete'), 'Удалить запись', `Нажмите ещё раз: удалить ${spec.what} насовсем`, async () => {
      await spec.remove(id);
      await goBack();
      toast(spec.done);
    });
  }
  show('entry', () => openEntry(kind, id));
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
      toast(err instanceof HasRepaymentsError ? 'По закупке есть погашения долга. Сначала удалите их.' : 'Сторно не сохранилось. Попробуйте ещё раз.');
      return;
    } finally {
      stornoSaving = false;
    }
    await openCard(x.id);
    toast(`Закупка №${pad3(x.no)} сторнирована`);
  };
}

/* Позиции. Вносятся после рынка, по чеку, в уже сохранённую закупку. */

const itemsForm = { purchase: null, balance: 0, repaid: 0, known: new Map(), armedAt: 0, saving: false };

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
  const [sum, receipt, history, repaid] = await Promise.all([
    db.periods.get(purchase.periodId).then(periodSummary),
    db.photos.where('purchaseId').equals(id).filter(p => p.kind === 'receipt').first(),
    getRecentPurchases(),
    repaidFor(id),
  ]);
  releaseViewPhotos();
  itemsForm.purchase = purchase;
  itemsForm.balance = sum.balance;
  itemsForm.repaid = repaid;
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
  const onDebt = !!debtOf(itemsForm.purchase);
  const diff = total - amount;
  // У закупки в долг разница ложится на долг, а не на аванс.
  const balance = onDebt ? itemsForm.balance : itemsForm.balance - diff;
  const notes = [];
  if (total && diff) {
    notes.push(`<div class="note warn"><span>Сумма закупки <b class="num">${money(amount)} сом</b>, по позициям <b class="num">${money(total)} сом</b>. Разница <b class="num">${diff > 0 ? '+' : ''}${money(diff)} сом</b>${onDebt ? ', на столько изменится долг поставщику' : ''}.</span></div>`);
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
  const { purchase } = itemsForm;
  if (items.length && debtOf(purchase) && total - purchase.paidNow < Math.max(itemsForm.repaid, 1)) {
    toast(`По позициям выходит ${money(total)} сом, а поставщику уже отдано ${money(purchase.paidNow + itemsForm.repaid)} сом. Проверьте позиции или удалите лишние погашения.`, 7000);
    return;
  }
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
  await openCard(id, await nextWithoutItems(itemsForm.purchase));
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

/* Списки за цифрами: нажатие на сумму показывает, из чего она сложилась */

// build() каждый раз читает базу заново: после правки в карточке «Назад» покажет свежий список.
async function openList(build) {
  const { title, body, bind } = await build();
  $('ls-title').textContent = title;
  $('ls-body').innerHTML = body;
  if (bind) bind();
  show('list', () => openList(build));
}

const countLabel = (n, one, few, many) => `${n} ${plural(n, one, few, many)}`;

function listBody({ sub, total, lines = [], ops, empty, after = '' }) {
  const line = ([label, value, cls = '']) => `<div class="${cls}"><span>${label}</span><span class="v">${value}</span></div>`;
  const totalRow = total === undefined ? [] : [['Итого', `${money(total)} сом`, 'total']];
  return (sub ? `<p class="muted hint">${sub}</p>` : '') +
    (lines.length || totalRow.length ? `<div class="sum">${[...lines, ...totalRow].map(line).join('')}</div>` : '') +
    after +
    `<div class="list">${ops.length ? ops.map(renderOperation).join('') : `<div class="empty">${empty}</div>`}</div>`;
}

const periodLabel = period => (period ? `Период ${esc(period.number)}` : 'Период не открыт');

async function periodData(periodId) {
  const period = periodId ? await db.periods.get(periodId) : null;
  return { period, sum: await periodSummary(period) };
}

// Закупки периода по условию: строки «в т.ч.» расчёта и плашки.
const periodPurchases = (title, filter, empty, withStorno = false) => periodId => async () => {
  const { period, sum } = await periodData(periodId);
  const list = sum.purchases.filter(p => (withStorno || p.status === 'active') && filter(p));
  return {
    title,
    body: listBody({
      sub: `${periodLabel(period)} · ${countLabel(list.length, 'закупка', 'закупки', 'закупок')}`,
      total: sumAmounts(list),
      ops: sortOps(await purchaseOps(list)),
      empty,
    }),
  };
};

const advancesList = periodId => async () => {
  const { period, sum } = await periodData(periodId);
  const open = period && period.status === 'open';
  return {
    title: 'Выдано авансом',
    body: listBody({
      sub: `${periodLabel(period)} · ${countLabel(sum.advances.length, 'выдача', 'выдачи', 'выдач')}`,
      total: sum.issued,
      ops: sortOps(advanceOps(sum.advances)),
      empty: 'Выдач в этом периоде нет.',
      after: open || !period ? '<button class="btn full" type="button" id="ls-act">+ Выдача аванса</button>' : '',
    }),
    bind: () => { if ($('ls-act')) $('ls-act').onclick = () => drill(() => openAdvance('advance')); },
  };
};

const returnsList = periodId => async () => {
  const { period, sum } = await periodData(periodId);
  const open = period && period.status === 'open';
  return {
    title: 'Возвращено в кассу',
    body: listBody({
      sub: `${periodLabel(period)} · ${countLabel(sum.returns.length, 'возврат', 'возврата', 'возвратов')}`,
      total: sum.returned,
      ops: sortOps(returnOps(sum.returns)),
      empty: 'Возвратов в этом периоде нет.',
      after: open ? '<button class="btn full" type="button" id="ls-act">Возврат денег</button>' : '',
    }),
    bind: () => { if ($('ls-act')) $('ls-act').onclick = () => drill(() => openAdvance('return')); },
  };
};

const repaymentsList = periodId => async () => {
  const { period, sum } = await periodData(periodId);
  return {
    title: 'Погашение долгов',
    body: listBody({
      sub: `${periodLabel(period)} · из аванса этого периода`,
      total: sum.repaid,
      ops: sortOps(await repaymentOps(sum.repayments)),
      empty: 'Погашений в этом периоде нет.',
    }),
  };
};

// Израсходовано из аванса: закупки без их части в долг и погашения долгов.
const spentList = periodId => async () => {
  const { period, sum } = await periodData(periodId);
  const active = sum.purchases.filter(p => p.status === 'active');
  const lines = sum.onDebt || sum.repaid
    ? [
      [`Закупки (${active.length})`, money(sum.bought)],
      ...(sum.onDebt ? [['<span class="muted">минус взятое в долг</span>', `−${money(sum.onDebt)}`]] : []),
      ...(sum.repaid ? [[`Погашение долгов (${sum.repayments.length})`, `+${money(sum.repaid)}`]] : []),
    ]
    : [];
  return {
    title: 'Израсходовано',
    body: listBody({
      sub: periodLabel(period),
      lines,
      total: sum.spent,
      ops: sortOps([...await purchaseOps(active), ...await repaymentOps(sum.repayments)]),
      empty: 'Расходов в этом периоде нет.',
    }),
  };
};

// Кому и сколько должен, по всем периодам. Дальше — поставщик и его закупки в долг.
const debtsList = () => async () => {
  const [debts, names] = await Promise.all([getDebts(), supplierNames()]);
  const bySupplier = new Map();
  debts.forEach(d => {
    const row = bySupplier.get(d.supplierId) || { id: d.supplierId, name: names.get(d.supplierId), left: 0, count: 0 };
    row.left += d.left;
    row.count += 1;
    bySupplier.set(d.supplierId, row);
  });
  const rows = [...bySupplier.values()].sort((a, b) => b.left - a.left);
  const total = sumLeft(debts);
  return {
    title: 'Кому должен',
    body: '<p class="muted hint">Товар взят в долг. Долг не входит в остаток аванса: из аванса уходят только погашения.</p>' +
      (rows.length ? `<div class="sum"><div class="total"><span>Всего долг</span><span class="v">${money(total)} сом</span></div></div>` : '') +
      `<div class="list">${rows.length
        ? rows.map(r => `<button class="item plain" type="button" data-open="supplier:${r.id}"><span class="body"><span class="t">${esc(r.name)}</span><span class="s">${countLabel(r.count, 'закупка', 'закупки', 'закупок')} в долг</span></span><span class="a">${money(r.left)}<span class="chev">›</span></span></button>`).join('')
        : '<div class="empty">Долгов нет.</div>'}</div>`,
  };
};

// Цифры плашки и строки расчёта в Отчёте ведут сюда.
const SUM_LISTS = {
  issued: advancesList,
  spent: spentList,
  bought: periodPurchases('Закупки', () => true, 'Закупок в этом периоде нет.'),
  services: periodPurchases('Услуги', p => p.type === 'service', 'Услуг в этом периоде нет.'),
  noDoc: periodPurchases('Без документов', p => p.docType === 'none', 'Все закупки с документами.'),
  onDebt: periodPurchases('Взято в долг', p => debtOf(p) > 0, 'В долг в этом периоде не брали.'),
  storno: periodPurchases('Сторно', p => p.status === 'storno', 'Сторно в этом периоде нет.', true),
  repaid: repaymentsList,
  returned: returnsList,
  debts: debtsList,
};

/* Поставщик: контакты, долг, все закупки и снимки */

function renderDebtRow(d) {
  const repaid = d.repaid ? `, погашено ${money(d.repaid)}` : '';
  return `<button class="item" type="button" data-open="card:${d.id}"><span class="no">№${pad3(d.no)}<br>${dShort(d.dt)}</span><span class="body"><span class="t">${esc(purchaseTitle(d))}</span><span class="s">в долг ${money(debtOf(d))}${repaid}</span></span><span class="a">${money(d.left)}</span></button>`;
}

async function openSupplier(id) {
  const [supplier, purchases, debts, shots] = await Promise.all([
    db.suppliers.get(id),
    db.purchases.where('supplierId').equals(id).toArray(),
    getDebts(),
    getSupplierPhotos(id),
  ]);
  const own = debts.filter(d => d.supplierId === id);
  const left = sumLeft(own);
  const active = purchases.filter(p => p.status === 'active');
  const row = (dt, dd) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`;
  releaseViewPhotos();
  $('sp-title').textContent = supplier.name;
  $('sp-body').innerHTML =
    '<dl class="kv">' +
    (supplier.phone ? row('Телефон', telLink(supplier.phone)) : '') +
    (supplier.place ? row('Базар', esc(supplier.place)) : '') +
    row('Закупки', `${active.length} на ${money(sumAmounts(active))} сом`) +
    (supplier.comment ? row('Комментарий', esc(supplier.comment)) : '') +
    (supplier.archived ? row('В архиве', 'да') : '') +
    '</dl>' +
    (left
      ? `<div class="section-h"><h3>Должен</h3><span class="num">${money(left)} сом</span></div>` +
        `<div class="list">${own.map(renderDebtRow).join('')}</div>` +
        '<button class="btn primary full" type="button" id="sp-repay">Погасить долг</button>'
      : '') +
    `<div class="section-h"><h3>Все закупки</h3><span class="muted tnum">${purchases.length}</span></div>` +
    `<div class="list">${purchases.length ? sortOps(await purchaseOps(purchases)).map(renderOperation).join('') : '<div class="empty">Закупок пока нет.</div>'}</div>` +
    (shots.length
      ? '<div class="section-h"><h3>Фото поставщика</h3></div>' + shots.map(({ blob, purchase }) =>
        `<img class="photo-full" src="${viewPhotoUrl(blob)}" alt="Фото поставщика, закупка №${pad3(purchase.no)}"><p class="muted hint">Закупка №${pad3(purchase.no)}, ${dFull(purchase.dt)}</p>`).join('')
      : '') +
    '<button class="btn full" type="button" id="sp-edit">Изменить данные поставщика</button>';
  if (left) $('sp-repay').onclick = () => drill(() => openRepay(own.map(d => d.id)));
  $('sp-edit').onclick = () => drill(() => openDict('supplier', id));
  show('supplier', () => openSupplier(id));
}

/* Погашение долга: из карточки закупки или со страницы поставщика сразу за несколько */

const repay = { ids: [], left: 0, balance: 0, range: null, saving: false };

async function openRepay(purchaseIds) {
  const debts = (await getDebts()).filter(d => purchaseIds.includes(d.id));
  if (!debts.length) {
    toast('Этот долг уже погашен.');
    return;
  }
  const [open, names] = await Promise.all([getOpenPeriod(), supplierNames()]);
  const { balance } = await periodSummary(open);
  const today = todayIso();
  // Погашение не раньше открытия текущего периода и не раньше самой закупки. Нового периода ещё нет — только сегодня.
  const latest = debts.reduce((max, d) => (d.dt.slice(0, 10) > max ? d.dt.slice(0, 10) : max), '');
  const from = open ? (open.opened > latest ? open.opened : latest) : today;
  repay.ids = debts.map(d => d.id);
  repay.left = sumLeft(debts);
  repay.balance = balance;
  repay.range = [from < today ? from : today, today];
  const suppliers = [...new Set(debts.map(d => names.get(d.supplierId)))];
  $('p-sum').innerHTML =
    `<div><span>${suppliers.length > 1 ? 'Поставщики' : 'Поставщик'}</span><span>${esc(suppliers.join(', '))}</span></div>` +
    `<div><span>${debts.length > 1 ? `Закупки (${debts.length})` : 'Закупка'}</span><span class="num">${debts.map(d => '№' + pad3(d.no)).join(', ')}</span></div>` +
    `<div class="total"><span>Осталось отдать</span><span class="v">${money(repay.left)} сом</span></div>`;
  $('p-amount').value = money(repay.left);
  $('p-comment').value = '';
  [$('p-date').min, $('p-date').max] = repay.range;
  $('p-date').value = today;
  chips($('p-method'), 'pmethod', Object.entries(MONEY_METHOD), 'cash');
  $('p-hint').textContent = (debts.length > 1 ? 'Сумма закроет долги по очереди, начиная со старого. ' : '') +
    `Деньги уйдут из аванса ${open ? `периода ${open.number}` : 'нового периода'}, даже если долг взят раньше.`;
  updateRepayNote();
  show('repay', () => openRepay(purchaseIds));
}

function updateRepayNote() {
  const amount = parseMoney($('p-amount').value) || 0;
  $('p-over').innerHTML = amount > repay.left
    ? `<div class="note bad"><span>Это больше долга. Отдать осталось <b class="num">${money(repay.left)} сом</b>.</span></div>`
    : amount > repay.balance
      ? `<div class="note bad"><span>Сумма больше остатка аванса. Перерасход составит <b class="num">${money(amount - Math.max(repay.balance, 0))} сом</b>, сохранить можно.</span></div>`
      : '';
}

$('p-amount').addEventListener('input', updateRepayNote);

$('p-save').onclick = async () => {
  if (repay.saving) return;
  const amount = parseMoney($('p-amount').value);
  const date = $('p-date').value;
  if (!amount) { toast('Введите сумму погашения.'); $('p-amount').focus(); return; }
  if (amount > repay.left) { toast(`Отдать осталось ${money(repay.left)} сом.`); $('p-amount').focus(); return; }
  if (!date || date < repay.range[0] || date > repay.range[1]) {
    toast(`Дата должна быть от ${dFull(repay.range[0])} до ${dFull(repay.range[1])}.`);
    $('p-date').focus();
    return;
  }
  repay.saving = true;
  $('p-save').disabled = true;
  try {
    await repayDebts(repay.ids, { amount, method: radioVal('pmethod'), dt: date + nowLocal().slice(10), comment: $('p-comment').value.trim() });
  } catch (err) {
    if (err instanceof LimitError) toast(`Отдать осталось ${money(err.limit)} сом.`);
    else {
      console.error(err);
      toast('Погашение не сохранилось. Попробуйте ещё раз.');
    }
    return;
  } finally {
    repay.saving = false;
    $('p-save').disabled = false;
  }
  await goBack();
  toast(amount === repay.left ? 'Долг погашен' : `Погашено ${money(amount)} сом, осталось ${money(repay.left - amount)} сом`);
};

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
  if (ANDROID && !$('ready').hidden) $('ready-close').click();
  return new Promise(resolve => {
    $('ready-name').textContent = `Файл готов: ${file.name}`;
    $('ready').hidden = false;
    $('ready-close').hidden = !ANDROID;
    $('ready-close').onclick = () => {
      $('ready').hidden = true;
      resolve(false);
    };
    $('ready-send').onclick = async () => {
      $('ready').hidden = true;
      resolve(await deliverFile(file, true));
    };
  });
}

function saveToDownloads(file) {
  downloadFile(file);
  toast(`Файл сохранён в «Загрузки»: ${file.name}. Отправьте его оттуда.`, 8000);
  return true;
}

// true, если файл передан. Отмена в окне «Поделиться» — не ошибка, а false.
async function deliverFile(file, retried = false) {
  if (ANDROID && ANDROID_NO_SHARE.test(file.name)) return saveToDownloads(file);
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
    if (err.name === 'NotAllowedError') return ANDROID && retried ? saveToDownloads(file) : offerFile(file);
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
  return `<div class="stat"><button class="stat-head" type="button" id="st-meter"><h3>Использование аванса<span class="chev">›</span></h3><span class="stat-big">${pct}%</span></button>` +
    `<div class="meter" role="img" aria-label="Использовано ${pct}% аванса"><i class="${level}" style="width:${Math.min(pct, 100)}%"></i></div>` +
    `<div class="stat-note">${note}</div></div>`;
}

function renderRangeTotal(stats) {
  return `<div class="stat"><button class="stat-head" type="button" id="st-total"><h3>Закуплено<span class="chev">›</span></h3><span class="stat-big">${money(stats.spent)} сом</span></button>` +
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
    `<button class="linkbtn" type="button" id="st-day">Больше всего: ${buckets[peak].label} — ${money(max)} сом ›</button>` +
    `<div class="plot" id="st-plot" role="img" aria-label="${esc(label)}">${columns}</div>` +
    `<div class="axis"><span>${buckets[0].label}</span><span>${buckets[buckets.length - 1].label}</span></div></div>`;
}

// Касание и ведение пальцем по графику: столбцы слишком узкие, чтобы попадать в каждый.
// Под графиком — выбранный столбец. Нажатие на подпись открывает его закупки.
function bindDays(stats) {
  const plot = $('st-plot');
  if (!plot) return;
  let picked = stats.buckets.findIndex(b => b.sum === Math.max(...stats.buckets.map(x => x.sum)));
  const select = e => {
    const box = plot.getBoundingClientRect();
    const i = Math.min(Math.max(Math.floor((e.clientX - box.left) / box.width * stats.buckets.length), 0), stats.buckets.length - 1);
    picked = i;
    [...plot.children].forEach((c, k) => c.classList.toggle('on', k === i));
    $('st-day').textContent = `${stats.buckets[i].label} — ${money(stats.buckets[i].sum)} сом ›`;
  };
  $('st-day').onclick = () => {
    const { from, to, label } = stats.buckets[picked];
    openStatsList(`Закупки ${label}`, p => p.dt.slice(0, 10) >= from && p.dt.slice(0, 10) <= to);
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
    `<div class="legend"><button type="button" data-type="goods"><i class="a"></i><span>Товары<span class="chev">›</span></span><span class="v">${money(stats.goodsSum)} · ${share(stats.goodsSum)}%</span></button>` +
    `<button type="button" data-type="service"><i class="b"></i><span>Услуги<span class="chev">›</span></span><span class="v">${money(stats.services)} · ${share(stats.services)}%</span></button></div></div>`;
}

function renderTopRows(rows) {
  if (!rows.length) return '<div class="stat-note">Пока нет данных.</div>';
  const max = rows.reduce((m, x) => Math.max(m, x.amount), 0);
  // «Прочие» не раскрываются: это сумма многих мелких строк.
  return rows.map((x, i) => {
    const inner = `<div class="rank-h"><span>${esc(x.name)}${x.other ? '' : '<span class="chev">›</span>'}</span><span class="v">${money(x.amount)}</span></div>` +
      (rows.length > 1 ? `<div class="rank-bar"><i class="${x.other ? 'other' : ''}" style="width:${x.amount / max * 100}%"></i></div>` : '');
    return x.other ? `<div>${inner}</div>` : `<button type="button" data-top="${i}">${inner}</button>`;
  }).join('');
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
  $('st-rank').onclick = e => {
    const b = e.target.closest('[data-top]');
    if (b) openTop(stats.top[topView][Number(b.dataset.top)].name);
  };
  if ($('st-total')) $('st-total').onclick = () => openStatsList('Закупки', () => true);
  $('r-stats').querySelectorAll('[data-type]').forEach(b => {
    b.onclick = () => openStatsList(b.dataset.type === 'goods' ? 'Товары' : 'Услуги', p => (p.type || 'goods') === b.dataset.type);
  });
}

// Что сейчас выбрано в статистике: период или даты. Список за ними читает базу заново при возврате.
function statsScope() {
  if (statsRange.mode === 'period') {
    const { period } = report;
    return {
      label: `Период ${period.number}`,
      load: async () => (await withSuppliers((await periodSummary(period)).purchases)).filter(p => p.status === 'active'),
    };
  }
  const [from, to] = rangeDates();
  return { label: from === to ? dFull(from) : `${dFull(from)} — ${dFull(to)}`, load: () => purchasesBetween(from, to) };
}

function openStatsList(title, filter) {
  const { label, load } = statsScope();
  drill(() => openList(async () => {
    const list = (await load()).filter(filter);
    return {
      title,
      body: listBody({
        sub: `${label} · ${countLabel(list.length, 'закупка', 'закупки', 'закупок')}`,
        total: sumAmounts(list),
        ops: sortOps(await purchaseOps(list)),
        empty: 'Закупок нет.',
      }),
    };
  }));
}

// Поставщик открывает свою страницу, базар и товар — закупки за выбранное время.
async function openTop(name) {
  if (topView === 'suppliers') {
    const supplier = await db.suppliers.where('name').equals(name).first();
    if (supplier) drill(() => openSupplier(supplier.id));
    return;
  }
  if (topView === 'bazaars') {
    openStatsList(name, p => p.type !== 'service' && (p.place || 'Не указан') === name);
    return;
  }
  openStatsList(name, p => (p.items.length ? p.items.some(i => i.name === name) : (p.title || 'Без названия') === name));
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
    if ($('st-meter')) $('st-meter').onclick = () => drill(() => openList(spentList(r.period.id)));
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

// Каждая строка расчёта раскрывается списком записей, из которых она сложилась.
function renderReportSum(r) {
  const row = ({ key, label, value, sub, cls = '' }) =>
    `<button type="button" data-sum="${key}"><span>${sub ? `<span class="muted">${label}</span>` : label}</span><span class="v ${cls}">${money(value)}<span class="chev">›</span></span></button>`;
  return settlementRows(r).map(row).join('') +
    `<div class="total"><span>${balanceLabel(r)}</span><span class="v ${r.balance < 0 ? 'bad' : ''}">${money(Math.abs(r.balance))} сом</span></div>` +
    (r.debtEnd ? row({ key: 'debts', label: debtEndLabel(r), value: r.debtEnd, cls: 'warn' }) : '');
}

$('r-sum').addEventListener('click', e => {
  const b = e.target.closest('[data-sum]');
  if (b) drill(() => openList(SUM_LISTS[b.dataset.sum](report.period.id)));
});

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
  // После загрузки архива номер периода может повториться: тогда различаем по датам.
  const repeated = number => periods.filter(p => p.number === number).length > 1;
  $('r-period').innerHTML = periods.slice().reverse().map(p => `<option value="${p.id}"${p.id === period.id ? ' selected' : ''}>${esc(p.number)}${repeated(p.number) ? `, с ${dFull(p.opened)}` : ''}</option>`).join('');
  $('r-status').textContent = (closed ? 'Закрыт' : 'Открыт') + (period.revision ? ` · редакция ${period.revision}` : '');
  $('r-sub').textContent = `${period.number} · ${dFull(period.opened)} — ${closed ? dFull(period.closed) : 'по сегодня'}${r.userName ? ' · ' + r.userName : ''}`;

  const notes = [];
  if (!r.userName) notes.push('<div class="note warn"><span>ФИО не указано. Заполните его в Настройках, оно попадёт в шапку отчёта.</span></div>');
  if (r.withoutItems.length) notes.push(`<div class="note warn"><span>Без позиций: ${withoutItemsLabel(r.withoutItems)}. В отчёте у них будет только сумма.</span>${closed ? '' : '<button class="linkbtn" type="button" id="r-noitems">Показать</button>'}</div>`);
  $('r-notes').innerHTML = notes.join('');
  if (r.withoutItems.length && !closed) {
    $('r-noitems').onclick = () => {
      homeNoItems = true;
      showHome();
    };
  }

  chips($('r-view'), 'rview', [['stats', 'Статистика'], ['sum', 'Итоги']], reportView);
  chips($('r-range'), 'range', Object.entries(STAT_MODES), statsRange.mode);
  await drawStats();
  applyReportView();
  $('r-sum').innerHTML = renderReportSum(r);
  $('r-table').innerHTML =
    '<thead><tr><th>№</th><th>Дата</th><th>Товар / услуга</th><th>Поставщик</th><th>Документ</th><th>Оплата</th><th class="r">Сумма</th></tr></thead><tbody>' +
    r.purchases.map(p => `<tr data-open="card:${p.id}"${p.status === 'storno' ? ' class="struck"' : ''}><td class="num">${pad3(p.no)}</td><td class="tnum">${dShort(p.dt)}</td><td>${esc(reportTitle(p))}</td><td>${esc(p.supplier)}</td><td>${DOC[p.docType]}</td><td>${PAY[p.payment]}</td><td class="r">${money(p.amount)}</td></tr>`).join('') +
    `</tbody><tfoot><tr><td colspan="6">Итого без сторно</td><td class="r">${money(r.bought)}</td></tr></tfoot>`;

  $('r-close').hidden = closed;
  if (closed) $('r-reopen').innerHTML = '<button class="btn danger full" type="button" id="r-reopen-open">Переоткрыть период</button>';
  if (closed) $('r-reopen-open').onclick = openReopen;
  show('report', () => showReport(period.id));
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

// В новый период остаток не переходит, поэтому неполный возврат нельзя оставить незамеченным.
function updateReturnNote() {
  const left = report.balance - (parseMoney($('cl-ret').value) || 0);
  $('cl-left').innerHTML = left > 0
    ? `<div class="note warn"><span>На руках останется <b class="num">${money(left)} сом</b>. В новый период этот остаток не перейдёт, он будет только в отчёте этого периода.</span></div>`
    : '';
}

async function openClose() {
  const r = report;
  const available = r.balance;
  const debt = sumLeft(await getDebts());
  closing.backedUp = false;
  $('cl-sum').innerHTML =
    `<div><span>Выдано</span><span class="v">${money(r.issued)}</span></div>` +
    `<div><span>Израсходовано</span><span class="v">${money(r.spent)}</span></div>` +
    (r.returned ? `<div><span>Уже возвращено</span><span class="v">${money(r.returned)}</span></div>` : '') +
    `<div class="total"><span>${available < 0 ? 'Перерасход' : 'Остаток на руках'}</span><span class="v ${available < 0 ? 'bad' : ''}">${money(Math.abs(available))} сом</span></div>`;
  const notes = [];
  if (r.withoutItems.length) notes.push(`<div class="note warn"><span>Без позиций: ${withoutItemsLabel(r.withoutItems)}. После закрытия внести их можно только через переоткрытие.</span></div>`);
  if (available < 0) notes.push(`<div class="note bad"><span>Перерасход <b class="num">${money(-available)} сом</b> будет зафиксирован в отчёте.</span></div>`);
  if (debt) notes.push(`<div class="note info"><span>Долг поставщикам <b class="num">${money(debt)} сом</b> не входит в остаток и после закрытия останется: погасить его можно из следующего аванса.</span></div>`);
  $('cl-notes').innerHTML = notes.join('');
  $('cl-ret').value = money(Math.max(available, 0));
  updateReturnNote();
  $('cl-check-l').textContent = `Бумажные документы (${r.docsCount} шт.) сданы в бухгалтерию`;
  $('cl-check').checked = false;
  $('cl-backup').textContent = 'Сохранить бэкап';
  $('cl-backup').disabled = false;
  updateCloseButton();
  show('close');
}

$('r-close').onclick = openClose;
$('cl-check').onchange = updateCloseButton;
$('cl-ret').addEventListener('input', updateReturnNote);

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
  if (ret > Math.max(r.balance, 0)) { toast('Возврат не может превышать остаток.'); $('cl-ret').focus(); return; }
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
  const [userName, org, lastBackupAt, suppliers, bazaars, purchases, debts] = await Promise.all([
    getSetting('userName'),
    getSetting('org'),
    getSetting('lastBackupAt'),
    db.suppliers.toArray(),
    db.bazaars.toArray(),
    db.purchases.where('status').equals('active').toArray(),
    getDebts(),
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
      const debt = sumLeft(debts.filter(d => d.supplierId === s.id));
      return `<button class="item plain" type="button" data-open="supplier:${s.id}"><span class="t">${esc(s.name)}${s.archived ? '<span class="tag warn">архив</span>' : ''}${debt ? `<span class="tag warn">долг ${money(debt)}</span>` : ''}</span><span class="s tnum">${own.length} закуп. · ${money(sumAmounts(own))}</span></button>`;
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
  const { periods, kept, purchases, photos, size } = await closedPeriodsData();
  const row = (label, value) => `<div><span>${label}</span><span class="v">${value}</span></div>`;
  archive.built = null;
  $('ar-sum').innerHTML = row('Закрытые периоды', periods.length) + row('Закупки', purchases.length) + row('Фото', `${photos.length}, ${formatSize(size)}`);
  const notes = [];
  if (!periods.length && !kept.length) notes.push('<div class="note warn"><span>Закрытых периодов пока нет. Архивируются только закрытые.</span></div>');
  if (kept.length) notes.push(`<div class="note warn"><span>Остаются в приложении: ${esc(kept.map(p => p.number).join(', '))}. В них есть непогашенный долг или погашение, связанное с открытым периодом.</span></div>`);
  $('ar-note').innerHTML = notes.join('');
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
  const overlaps = await countNumberOverlaps(tables.purchases);
  $('ua-note').innerHTML = overlaps
    ? `<div class="note warn"><span>Совпадают номера: ${overlaps} ${plural(overlaps, 'закупка', 'закупки', 'закупок')}. Архивные сохранят свои номера с чеков, отличить их можно по дате и периоду. Новые номера пойдут дальше.</span></div>`
    : '';
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
  show('dict', () => openDict(kind, id));
}

$('s-baz').addEventListener('click', e => {
  const b = e.target.closest('[data-dict]');
  if (b) drill(() => openDict(b.dataset.dict, Number(b.dataset.id)));
});

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
  await goBack();
  toast('Сохранено');
}

$('d-save').onclick = submitDict;

/* Выдача аванса и возврат денег: одна форма, деньги идут в разные стороны */

const advForm = { mode: 'advance', balance: 0, range: null, saving: false };

async function openAdvance(mode) {
  const ret = mode === 'return';
  const today = todayIso();
  advForm.mode = mode;
  if (ret) {
    const period = await getOpenPeriod();
    advForm.balance = (await periodSummary(period)).balance;
    if (!period || advForm.balance <= 0) {
      toast(advForm.balance < 0 ? 'Сейчас перерасход: возвращать нечего.' : 'На руках ничего не осталось: возвращать нечего.');
      return;
    }
    advForm.range = [period.opened < today ? period.opened : today, today];
  }
  $('a-title').textContent = ret ? 'Возврат денег' : 'Выдача аванса';
  $('a-by-label').textContent = ret ? 'Кому вернул' : 'Кто выдал';
  $('a-comment-field').hidden = !ret;
  $('a-save').textContent = ret ? 'Сохранить возврат' : 'Добавить выдачу';
  $('a-note').innerHTML = ret ? `<div class="note info"><span>На руках <b class="num">${money(advForm.balance)} сом</b>. Вернуть можно не больше.</span></div>` : '';
  $('a-amount').value = '';
  $('a-by').value = 'Бухгалтерия';
  $('a-comment').value = '';
  [$('a-date').min, $('a-date').max] = ret ? advForm.range : ['', ''];
  $('a-date').value = today;
  chips($('a-method'), 'method', Object.entries(ret ? MONEY_METHOD : ADV_METHOD), 'cash');
  show('adv', () => openAdvance(mode));
}

async function submitAdvance() {
  if (advForm.saving) return;
  const ret = advForm.mode === 'return';
  const amount = parseMoney($('a-amount').value);
  const date = $('a-date').value || todayIso();
  if (!amount) { toast(ret ? 'Введите сумму возврата.' : 'Введите сумму аванса.'); $('a-amount').focus(); return; }
  if (ret && amount > advForm.balance) { toast(`Вернуть можно не больше ${money(advForm.balance)} сом.`); $('a-amount').focus(); return; }
  if (ret && (date < advForm.range[0] || date > advForm.range[1])) {
    toast(`Дата должна быть от ${dFull(advForm.range[0])} до ${dFull(advForm.range[1])}.`);
    $('a-date').focus();
    return;
  }

  advForm.saving = true;
  $('a-save').disabled = true;
  try {
    const who = $('a-by').value.trim() || '—';
    if (ret) await addReturn({ amount, method: radioVal('method'), to: who, dt: date + nowLocal().slice(10), comment: $('a-comment').value.trim() });
    else await addAdvance({ amount, method: radioVal('method'), by: who, date });
  } catch (err) {
    if (err instanceof LimitError) toast(`Вернуть можно не больше ${money(err.limit)} сом.`);
    else {
      console.error(err);
      toast(ret ? 'Возврат не сохранился. Попробуйте ещё раз.' : 'Выдача не сохранилась. Попробуйте ещё раз.');
    }
    return;
  } finally {
    advForm.saving = false;
    $('a-save').disabled = false;
  }

  await goBack();
  toast(ret ? `Возврат ${money(amount)} сом сохранён` : `Выдача ${money(amount)} сом добавлена`);
}

$('a-save').onclick = submitAdvance;

/* Запуск */

// Отладчик к телефону не подключить, поэтому на Android причина видна прямо на экране.
function errorDetails(reason) {
  const { name, message, stack } = Object(reason);
  const place = /(?:app|db|reports)\.js:\d+/.exec(stack || '');
  return [name, message || String(reason), place && place[0]].filter(Boolean).join(' · ').slice(0, 200);
}

window.addEventListener('unhandledrejection', e => {
  console.error(e.reason);
  if (ANDROID) toast(`Ошибка приложения: ${errorDetails(e.reason)}. Закройте его и откройте снова.`, 20000);
  else toast('Ошибка приложения. Закройте его и откройте снова.');
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
