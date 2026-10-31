'use strict';
// Данные приложения: схема Dexie, запись операций, деньги и даты. Интерфейса здесь нет.

const db = new Dexie('zakup');

// Нумерация обнуляется в январе, поэтому номер уникален только в пределах года: &[year+no].
db.version(1).stores({
  periods: '++id, number, status',
  advances: '++id, periodId, date',
  purchases: '++id, &[year+no], periodId, dt, supplierId, purposeId, status',
  photos: '++id, purchaseId',
  suppliers: '++id, &name',
  purposes: '++id, &name',
  counters: '&key',
  auditLog: '++id, entity, entityId, at',
  settings: '&key',
});

const BAZAARS = ['Дордой', 'Ош базар', 'Аламедин', 'Орто-Сай', 'Мадина', 'АЮ Гранд'];

const seedBazaars = tx => tx.table('bazaars').bulkAdd(BAZAARS.map(name => ({ name, active: true })));

// До версии 2 закупка была только товаром и без наименования: оно бралось из комментария.
function migratePurchaseV2(purchase) {
  purchase.type = 'goods';
  purchase.goodsName = purchase.comment || '';
}

// Версия 2: тип закупки (товар или услуга), наименование и справочник базаров. Назначения убраны из приложения,
// но таблица и purposeId остаются: на них ссылаются старые записи журнала.
db.version(2).stores({ bazaars: '++id, &name' }).upgrade(async tx => {
  await seedBazaars(tx);
  await tx.table('purchases').toCollection().modify(migratePurchaseV2);
});

// Версия 3: номер уникален внутри периода, а не во всём году. Закупка из архива сохраняет номер,
// написанный на чеке, даже если такой уже выдан заново, например после удаления всех записей.
db.version(3).stores({ purchases: '++id, &[periodId+year+no], periodId, dt, supplierId, purposeId, status' });

db.on('populate', tx => {
  seedBazaars(tx);
  tx.table('settings').add({ key: 'org', value: 'Азия Сталь' });
});

/* Деньги: целые тыйыны. Float не участвует ни при разборе, ни при выводе. */

// '1 250,50' → 125050. null, если строка не является суммой.
function parseMoney(text) {
  const m = /^(\d{1,10})(?:[.,](\d{0,2}))?$/.exec(String(text).replace(/\s/g, ''));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
}

// 125050 → '1 250,50' (неразрывный пробел), 125000 → '1 250'.
function money(tyiyn) {
  const abs = Math.abs(tyiyn);
  const frac = abs % 100;
  const whole = String((abs - frac) / 100).replace(/\B(?=(\d{3})+$)/g, ' ');
  return (tyiyn < 0 ? '−' : '') + whole + (frac ? ',' + String(frac).padStart(2, '0') : '');
}

// Количество: до 3 знаков после запятой. null, если строка не является числом.
function parseQty(text) {
  const m = /^(\d{1,6})(?:[.,](\d{0,3}))?$/.exec(String(text).replace(/\s/g, ''));
  return m ? Number(`${m[1]}.${m[2] || '0'}`) : null;
}

// Считается через целые тысячные: в float 1.005 * 100 = 100.49999…, и тыйын терялся бы.
const itemSum = (qty, price) => Math.round(Math.round(qty * 1000) * price / 1000);

/* Даты: только локальное время устройства. toISOString() дал бы UTC и сдвинул день и год. */

function nowLocal() {
  const d = new Date();
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
}

const purchaseCounterKey = year => `purchase-${year}`;

class NameTakenError extends Error {}
class PeriodOpenError extends Error {}
class BackupError extends Error {}

const BACKUP_MAX_DAYS = 7;
const BACKUP_MAX_PURCHASES = 20;

/* Чтение */

const getOpenPeriod = () => db.periods.where('status').equals('open').first();

// Открытый период, а если его нет — последний закрытый: главная показывает его итог.
const getCurrentPeriod = async () => (await getOpenPeriod()) || db.periods.toCollection().last();

// Сторно обычно означает ошибку, поэтому значения по умолчанию из него не берутся.
// Что куплено: позиции точнее наименования из формы, поэтому в списке и отчётах они важнее.
const purchaseTitle = p => (p.items.length ? p.items.map(i => i.name).join(', ') : p.goodsName);

const getLastPurchase = () => db.purchases.toCollection().reverse().filter(p => p.status === 'active').first();

// Действующие закупки, новые первыми: из них строятся подсказки при вводе.
const getRecentPurchases = () => db.purchases.toCollection().reverse().filter(p => p.status === 'active').toArray();

// Отдельно от последней закупки: у услуги базара нет, и он не должен сбрасываться.
async function getLastPlace() {
  const purchase = await db.purchases.toCollection().reverse().filter(p => p.status === 'active' && p.place).first();
  return purchase ? purchase.place : '';
}

async function getSetting(key) {
  const row = await db.settings.get(key);
  return row ? row.value : undefined;
}

// Напоминание о бэкапе: больше 7 дней или больше 20 закупок с прошлого раза. null, если пока рано.
async function backupReminder() {
  const first = await db.purchases.orderBy('dt').first();
  if (!first) return null;
  const lastAt = await getSetting('lastBackupAt');
  const days = Math.floor((Date.now() - new Date(lastAt || first.dt).getTime()) / 864e5);
  const count = await (lastAt ? db.purchases.where('dt').above(lastAt).count() : db.purchases.count());
  return days > BACKUP_MAX_DAYS || count > BACKUP_MAX_PURCHASES ? { days, count, never: !lastAt } : null;
}

// Номер, который получит следующая закупка. Только для показа: выдаётся он в savePurchase.
async function peekPurchaseNo() {
  const row = await db.counters.get(purchaseCounterKey(Number(nowLocal().slice(0, 4))));
  return (row ? row.value : 0) + 1;
}

const sumAmounts = list => list.reduce((sum, x) => sum + x.amount, 0);

// Остаток нигде не хранится и считается здесь: Σ выдач − Σ активных закупок − возврат.
async function periodSummary(period) {
  const advances = period ? await db.advances.where('periodId').equals(period.id).toArray() : [];
  const purchases = period ? await db.purchases.where('periodId').equals(period.id).toArray() : [];
  const active = purchases.filter(p => p.status === 'active');
  const issued = sumAmounts(advances);
  const spent = sumAmounts(active);
  const ret = period ? period.ret : 0;
  return {
    advances,
    purchases,
    issued,
    spent,
    noDoc: sumAmounts(active.filter(p => p.docType === 'none')),
    count: active.length,
    balance: issued - spent - ret,
  };
}

/* Запись. Эти функции вызываются только внутри транзакции. */

async function nextCounter(key) {
  const row = await db.counters.get(key);
  const value = (row ? row.value : 0) + 1;
  await db.counters.put({ key, value });
  return value;
}

// Одновременно открыт один период. Новый создаётся при первой операции после закрытия прошлого.
async function ensureOpenPeriod(date) {
  const open = await getOpenPeriod();
  if (open) return open;
  const year = date.slice(0, 4);
  const seq = await nextCounter(`period-${year}`);
  const period = {
    number: `П-${year}-${String(seq).padStart(2, '0')}`,
    status: 'open',
    opened: date,
    closed: null,
    ret: 0,
    revision: 0,
  };
  period.id = await db.periods.add(period);
  return period;
}

async function findOrCreateSupplier(name, place, phone) {
  const known = await db.suppliers.where('name').equalsIgnoreCase(name).first();
  if (!known) return db.suppliers.add({ name, place, phone, comment: '', archived: false });
  const changes = {};
  if (place && !known.place) changes.place = place;
  if (phone) changes.phone = phone;
  await applyChanges(db.suppliers, 'supplier', known, changes);
  return known.id;
}

async function assertNameFree(table, name, id) {
  const twin = await table.where('name').equalsIgnoreCase(name).first();
  if (twin && twin.id !== id) throw new NameTakenError();
}

// Записывает только реально изменённые поля и каждое из них — в журнал.
async function applyChanges(table, entity, record, changes) {
  const diff = {};
  for (const [field, after] of Object.entries(changes)) {
    const before = record[field];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    diff[field] = after;
    await db.auditLog.add({ entity, entityId: record.id, field, before, after, at: nowLocal() });
  }
  if (Object.keys(diff).length) await table.update(record.id, diff);
}

// Закрытый период и сторнированная закупка не редактируются.
async function getEditablePurchase(id) {
  const purchase = await db.purchases.get(id);
  const period = await db.periods.get(purchase.periodId);
  if (purchase.status !== 'active' || period.status !== 'open') throw new Error('Закупка не редактируется');
  return purchase;
}

/* Операции */

function addAdvance({ amount, method, by, date }) {
  return db.transaction('rw', db.advances, db.periods, db.counters, async () => {
    const period = await ensureOpenPeriod(date);
    await db.advances.add({ periodId: period.id, date, amount, method, by, comment: '' });
  });
}

// Фото сжимается до вызова: внутри транзакции нельзя ждать ничего, кроме самой базы.
// photos: [{ kind: 'receipt' | 'goods' | 'supplier', blob }].
function savePurchase({ type, goodsName, amount, supplierName, phone, place, docType, payment, comment }, photos) {
  const dt = nowLocal();
  const year = Number(dt.slice(0, 4));
  return db.transaction('rw', db.purchases, db.counters, db.photos, db.suppliers, db.periods, db.auditLog, async () => {
    const period = await ensureOpenPeriod(dt.slice(0, 10));
    const supplierId = await findOrCreateSupplier(supplierName, place, phone);
    const no = await nextCounter(purchaseCounterKey(year));
    const id = await db.purchases.add({
      year, no, periodId: period.id, dt, type, goodsName, supplierId, place, amount,
      payment, docType, comment, items: [], status: 'active', stornoReason: null,
    });
    await db.photos.bulkAdd(photos.map(photo => ({ ...photo, purchaseId: id })));
    return { id, no, periodId: period.id };
  });
}

// date — только день, время покупки остаётся прежним.
function updatePurchase(id, { type, goodsName, date, amount, supplierName, phone, place, docType, payment, comment }) {
  return db.transaction('rw', db.purchases, db.periods, db.suppliers, db.auditLog, async () => {
    const purchase = await getEditablePurchase(id);
    const supplierId = await findOrCreateSupplier(supplierName, place, phone);
    const changes = { type, goodsName, dt: date + purchase.dt.slice(10), supplierId, place, docType, payment, comment };
    // Сумма закупки с позициями считается только по ним.
    if (!purchase.items.length) changes.amount = amount;
    await applyChanges(db.purchases, 'purchase', purchase, changes);
  });
}

// Пустой список убирает позиции, сумма закупки при этом остаётся прежней.
function savePurchaseItems(id, items) {
  return db.transaction('rw', db.purchases, db.periods, db.auditLog, async () => {
    const purchase = await getEditablePurchase(id);
    const changes = { items };
    if (items.length) changes.amount = items.reduce((sum, item) => sum + item.sum, 0);
    await applyChanges(db.purchases, 'purchase', purchase, changes);
  });
}

// Вечером чеки разбираются подряд: следующая закупка периода без позиций, после последней — с начала.
async function nextWithoutItems({ id, periodId }) {
  const purchases = await db.purchases.where('periodId').equals(periodId).toArray();
  const rest = purchases.filter(p => p.status === 'active' && !p.items.length && p.id !== id);
  return rest.length ? { purchase: rest.find(p => p.id > id) || rest[0], left: rest.length } : null;
}

function stornoPurchase(id, reason) {
  return db.transaction('rw', db.purchases, db.periods, db.auditLog, async () => {
    const purchase = await getEditablePurchase(id);
    await applyChanges(db.purchases, 'purchase', purchase, { status: 'storno', stornoReason: reason });
  });
}

function saveSupplier(id, changes) {
  return db.transaction('rw', db.suppliers, db.auditLog, async () => {
    await assertNameFree(db.suppliers, changes.name, id);
    await applyChanges(db.suppliers, 'supplier', await db.suppliers.get(id), changes);
  });
}

function addBazaar(name) {
  return db.transaction('rw', db.bazaars, db.auditLog, async () => {
    await assertNameFree(db.bazaars, name);
    const id = await db.bazaars.add({ name, active: true });
    await db.auditLog.add({ entity: 'bazaar', entityId: id, field: 'name', before: null, after: name, at: nowLocal() });
  });
}

// В закупках базар хранится названием, поэтому переименование не меняет уже сданные отчёты.
function saveBazaar(id, changes) {
  return db.transaction('rw', db.bazaars, db.auditLog, async () => {
    await assertNameFree(db.bazaars, changes.name, id);
    await applyChanges(db.bazaars, 'bazaar', await db.bazaars.get(id), changes);
  });
}

// Фото сжимаются до вызова: внутри транзакции нельзя ждать ничего, кроме самой базы.
// Снимки поставщика лежат в его закупках, новые первыми.
async function getSupplierPhotos(supplierId) {
  const purchases = await db.purchases.where('supplierId').equals(supplierId).toArray();
  const byId = new Map(purchases.map(p => [p.id, p]));
  const photos = await db.photos.where('purchaseId').anyOf([...byId.keys()]).filter(p => p.kind === 'supplier').toArray();
  return photos.sort((a, b) => b.id - a.id).map(photo => ({ ...photo, purchase: byId.get(photo.purchaseId) }));
}

function addPhotos(purchaseId, kind, blobs) {
  return db.transaction('rw', db.purchases, db.periods, db.photos, db.auditLog, async () => {
    await getEditablePurchase(purchaseId);
    await db.photos.bulkAdd(blobs.map(blob => ({ purchaseId, kind, blob })));
    await db.auditLog.add({ entity: 'purchase', entityId: purchaseId, field: 'photoAdded', before: null, after: blobs.length, at: nowLocal() });
  });
}

function deletePhoto(id) {
  return db.transaction('rw', db.purchases, db.periods, db.photos, db.auditLog, async () => {
    const photo = await db.photos.get(id);
    await getEditablePurchase(photo.purchaseId);
    await db.photos.delete(id);
    await db.auditLog.add({ entity: 'purchase', entityId: photo.purchaseId, field: 'photoDeleted', before: 1, after: null, at: nowLocal() });
  });
}

// Удаление ошибочной записи. Номер не освобождается: он мог уже попасть на бумажный чек.
function deletePurchase(id) {
  return db.transaction('rw', db.purchases, db.periods, db.photos, db.auditLog, async () => {
    const purchase = await db.purchases.get(id);
    const period = await db.periods.get(purchase.periodId);
    if (period.status !== 'open') throw new Error('Период закрыт');
    await db.photos.where('purchaseId').equals(id).delete();
    await db.purchases.delete(id);
    const label = `№${String(purchase.no).padStart(3, '0')} ${purchaseTitle(purchase)}, ${money(purchase.amount)} сом`;
    await db.auditLog.add({ entity: 'purchase', entityId: id, field: 'deleted', before: label, after: null, at: nowLocal() });
  });
}

function deleteAdvance(id) {
  return db.transaction('rw', db.advances, db.periods, db.auditLog, async () => {
    const advance = await db.advances.get(id);
    const period = await db.periods.get(advance.periodId);
    if (period.status !== 'open') throw new Error('Период закрыт');
    await db.advances.delete(id);
    await db.auditLog.add({ entity: 'advance', entityId: id, field: 'deleted', before: `${money(advance.amount)} сом от ${advance.date}`, after: null, at: nowLocal() });
  });
}

// Закрытые периоды уходят в архивный файл. Счётчики не трогаем: номера не должны повториться.
function removeArchivedPeriods(periodIds, label) {
  return db.transaction('rw', db.periods, db.advances, db.purchases, db.photos, db.auditLog, async () => {
    const purchaseIds = await db.purchases.where('periodId').anyOf(periodIds).primaryKeys();
    await db.photos.where('purchaseId').anyOf(purchaseIds).delete();
    await db.auditLog.filter(e => (e.entity === 'purchase' && purchaseIds.includes(e.entityId)) || (e.entity === 'period' && periodIds.includes(e.entityId))).delete();
    await db.purchases.where('periodId').anyOf(periodIds).delete();
    await db.advances.where('periodId').anyOf(periodIds).delete();
    await db.periods.bulkDelete(periodIds);
    await db.auditLog.add({ entity: 'archive', entityId: 0, field: 'toArchive', before: null, after: label, at: nowLocal() });
  });
}

async function raiseCounter(key, value) {
  const row = await db.counters.get(key);
  if (!row || row.value < value) await db.counters.put({ key, value });
}

// Сколько закупок архива получат номер, уже занятый в приложении: об этом предупреждаем до загрузки.
async function countNumberOverlaps(purchases) {
  const taken = new Set((await db.purchases.toArray()).map(p => `${p.year}-${p.no}`));
  return purchases.filter(p => taken.has(`${p.year}-${p.no}`)).length;
}

// Архив добавляется к текущим данным с новыми id, поставщики сопоставляются по имени.
function mergeArchive({ tables }, label) {
  return db.transaction('rw', [db.periods, db.advances, db.purchases, db.photos, db.suppliers, db.counters, db.auditLog], async () => {
    const stripId = ({ id, ...record }) => record;
    const periodIds = new Map();
    for (const period of tables.periods) {
      const same = await db.periods.where('number').equals(period.number).filter(p => p.opened === period.opened && p.closed === period.closed).first();
      if (same) throw new BackupError(`Период ${period.number} уже загружен.`);
      periodIds.set(period.id, await db.periods.add(stripId(period)));
    }
    const supplierIds = new Map();
    for (const supplier of tables.suppliers) {
      const known = await db.suppliers.where('name').equalsIgnoreCase(supplier.name).first();
      supplierIds.set(supplier.id, known ? known.id : await db.suppliers.add(stripId(supplier)));
    }
    for (const advance of tables.advances) await db.advances.add({ ...stripId(advance), periodId: periodIds.get(advance.periodId) });
    const purchaseIds = new Map();
    for (const purchase of tables.purchases) {
      purchaseIds.set(purchase.id, await db.purchases.add({ ...stripId(purchase), periodId: periodIds.get(purchase.periodId), supplierId: supplierIds.get(purchase.supplierId) }));
    }
    for (const photo of tables.photos) await db.photos.add({ ...stripId(photo), purchaseId: purchaseIds.get(photo.purchaseId) });
    for (const entry of tables.auditLog) {
      const ids = entry.entity === 'period' ? periodIds : purchaseIds;
      await db.auditLog.add({ ...stripId(entry), entityId: ids.get(entry.entityId) });
    }
    // Новые номера идут дальше архивных: совпадений больше не появится.
    for (const { year, no } of tables.purchases) await raiseCounter(purchaseCounterKey(year), no);
    for (const { number } of tables.periods) {
      const [, year, seq] = number.split('-');
      await raiseCounter(`period-${year}`, Number(seq));
    }
    await db.auditLog.add({ entity: 'archive', entityId: 0, field: 'fromArchive', before: null, after: label, at: nowLocal() });
  });
}

// Чистый старт перед работой: всё учётное стирается, нумерация начинается заново.
// ФИО, организация и базары остаются: это настройки, а не записи.
function wipeRecords() {
  const tables = [db.periods, db.advances, db.purchases, db.photos, db.suppliers, db.counters, db.auditLog];
  return db.transaction('rw', [...tables, db.settings], async () => {
    await Promise.all(tables.map(table => table.clear()));
    await db.settings.delete('lastBackupAt');
  });
}

const setSetting = (key, value) => db.settings.put({ key, value });

function openNewPeriod() {
  return db.transaction('rw', db.periods, db.counters, () => ensureOpenPeriod(nowLocal().slice(0, 10)));
}

function closePeriod(id, ret) {
  return db.transaction('rw', db.periods, db.advances, db.purchases, db.auditLog, async () => {
    const period = await db.periods.get(id);
    if (period.status !== 'open') throw new Error('Период уже закрыт');
    const { issued, spent } = await periodSummary(period);
    if (ret > Math.max(issued - spent, 0)) throw new Error('Возврат больше остатка');
    await applyChanges(db.periods, 'period', period, { status: 'closed', closed: nowLocal().slice(0, 10), ret });
  });
}

// Открытым может быть только один период, поэтому при открытом переоткрыть нельзя.
function reopenPeriod(id, reason) {
  return db.transaction('rw', db.periods, db.auditLog, async () => {
    if (await getOpenPeriod()) throw new PeriodOpenError();
    const period = await db.periods.get(id);
    await applyChanges(db.periods, 'period', period, {
      status: 'open', closed: null, revision: period.revision + 1, reopenReason: reason,
    });
  });
}

// Полная замена без слияния. Любая ошибка откатывает всё целиком, и старые данные остаются.
function restoreAll(tables, exportedAt) {
  return db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) {
      await table.clear();
      await table.bulkAdd(tables[table.name]);
    }
    await setSetting('lastBackupAt', exportedAt);
  });
}
