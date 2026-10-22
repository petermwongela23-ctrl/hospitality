const DB_NAME = 'afya-field-notes';
const DB_VERSION = 1;
const STORE_NAME = 'visits';

const form = document.querySelector('#visit-form');
const list = document.querySelector('#record-list');
const notice = document.querySelector('#notice');
const networkBar = document.querySelector('#network-status');
const networkLabel = document.querySelector('#network-label');
const pendingCount = document.querySelector('#pending-count');
const recordCount = document.querySelector('#record-count');
const serverStatus = document.querySelector('#server-status');
const syncButton = document.querySelector('#sync-button');

let database;
let syncing = false;
let noticeTimer;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'local_id' });
        store.createIndex('created_at_local', 'created_at_local');
        store.createIndex('sync_status', 'sync_status');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local record storage.'));
    request.onblocked = () => reject(new Error('Close other app tabs, then reload this page.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Local storage operation failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Local storage operation was cancelled.'));
  });
}

async function putRecord(record) {
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).put(record);
  await transactionDone(transaction);
}

async function getAllRecords() {
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const request = transaction.objectStore(STORE_NAME).getAll();
  const result = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not read saved records.'));
  });
  await transactionDone(transaction);
  return result.sort((a, b) => b.created_at_local.localeCompare(a.created_at_local));
}

async function updateRecord(localId, changes) {
  const records = await getAllRecords();
  const current = records.find((record) => record.local_id === localId);
  if (current) await putRecord({ ...current, ...changes });
}

function showNotice(message, isError = false) {
  window.clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.classList.toggle('error', isError);
  notice.hidden = false;
  noticeTimer = window.setTimeout(() => { notice.hidden = true; }, 5000);
}

function setNetworkStatus() {
  const online = navigator.onLine;
  networkBar.classList.toggle('offline', !online);
  networkBar.classList.toggle('checking', false);
  networkLabel.textContent = online ? 'ONLINE' : 'OFFLINE';
}

function statusText(status) {
  if (status === 'Synced') return 'Synced';
  if (status === 'Syncing') return 'Syncing';
  return 'Pending';
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function addText(parent, tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

async function renderRecords() {
  const records = await getAllRecords();
  const waiting = records.filter((record) => record.sync_status !== 'Synced').length;
  pendingCount.textContent = String(waiting);
  recordCount.textContent = String(records.length);
  list.replaceChildren();

  if (records.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    addText(empty, 'span', 'empty-icon', '▤');
    addText(empty, 'strong', '', 'No visits saved yet');
    addText(empty, 'span', '', 'Saved visits will appear here.');
    list.append(empty);
    return;
  }

  for (const record of records) {
    const row = document.createElement('article');
    row.className = 'record-row';
    const main = document.createElement('div');
    main.className = 'record-main';
    addText(main, 'div', 'record-name', record.patient_name);
    const meta = document.createElement('div');
    meta.className = 'record-meta';
    for (const value of [record.visit_type, record.village_name, record.vitals_bp, `${Number(record.vitals_temp).toFixed(1)} °C`, formatDate(record.created_at_local)]) {
      addText(meta, 'span', '', value);
    }
    main.append(meta);
    row.append(main);

    const badge = addText(row, 'span', 'record-status', statusText(record.sync_status));
    if (record.sync_status === 'Synced') badge.classList.add('synced');
    if (record.sync_status === 'Syncing') badge.classList.add('syncing');
    if (record.sync_error) {
      const error = addText(row, 'div', 'record-error', record.sync_error);
      error.title = record.sync_error;
    }
    list.append(row);
  }
}

function validateFormData(data) {
  if (data.patient_name.trim().length < 2) return 'Patient name must have at least 2 characters.';
  if (!/^\d{2,3}\/\d{2,3}$/.test(data.vitals_bp.trim())) return 'Enter blood pressure like 120/80.';
  const temperature = Number(data.vitals_temp);
  if (!Number.isFinite(temperature) || temperature < 35 || temperature > 43) return 'Temperature must be between 35.0 and 43.0 °C.';
  return '';
}

function newLocalId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `chw-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;

  const values = Object.fromEntries(new FormData(form).entries());
  const validationError = validateFormData(values);
  if (validationError) {
    showNotice(validationError, true);
    return;
  }

  const record = {
    local_id: newLocalId(),
    chw_id: values.chw_id.trim(),
    patient_name: values.patient_name.trim(),
    village_name: values.village_name.trim(),
    visit_type: values.visit_type,
    vitals_bp: values.vitals_bp.trim(),
    vitals_temp: Number(values.vitals_temp),
    urgency_level: values.urgency_level,
    visit_notes: values.visit_notes.trim(),
    created_at_local: new Date().toISOString(),
    sync_status: 'Pending',
    sync_error: ''
  };

  try {
    await putRecord(record);
    form.reset();
    await renderRecords();
    showNotice('Visit saved on this device.');
    if (navigator.onLine) await syncQueue();
  } catch (error) {
    showNotice(`Could not save this visit locally: ${error.message}`, true);
  }
});

async function checkServer() {
  if (!navigator.onLine) {
    serverStatus.textContent = 'Server unreachable offline';
    return;
  }
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    if (!response.ok) throw new Error('Server responded with an error.');
    const health = await response.json();
    serverStatus.textContent = `Server ready • ${health.total_records} received`;
  } catch {
    serverStatus.textContent = 'Server not reachable';
  }
}

async function syncQueue() {
  if (syncing) return;
  if (!navigator.onLine) {
    showNotice('You are offline. Saved visits will stay on this device.', true);
    return;
  }
  syncing = true;
  syncButton.disabled = true;
  serverStatus.textContent = 'Syncing…';
  try {
    const records = (await getAllRecords()).filter((record) => record.sync_status !== 'Synced');
    if (records.length === 0) {
      showNotice('The sync queue is already clear.');
      await checkServer();
      return;
    }

    for (const record of records) {
      await updateRecord(record.local_id, { sync_status: 'Syncing', sync_error: '' });
    }
    await renderRecords();
    const response = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Sync failed with HTTP ${response.status}.`);
    }
    const result = await response.json();
    const outcomes = new Map(result.results.map((item) => [item.local_id, item]));
    let accepted = 0;
    for (const record of records) {
      const outcome = outcomes.get(record.local_id);
      if (outcome && ['synced', 'duplicate'].includes(outcome.status)) {
        accepted += 1;
        await updateRecord(record.local_id, { sync_status: 'Synced', sync_error: '' });
      } else {
        await updateRecord(record.local_id, { sync_status: 'Pending', sync_error: outcome?.error || 'The server did not confirm this record.' });
      }
    }
    await renderRecords();
    await checkServer();
    const rejected = records.length - accepted;
    if (rejected > 0) showNotice(`${accepted} synced. ${rejected} still need attention.`, true);
    else showNotice(`${accepted} visit${accepted === 1 ? '' : 's'} synced successfully.`);
  } catch (error) {
    for (const record of await getAllRecords()) {
      if (record.sync_status === 'Syncing') await updateRecord(record.local_id, { sync_status: 'Pending', sync_error: error.message });
    }
    await renderRecords();
    serverStatus.textContent = 'Sync failed • saved locally';
    showNotice(`Sync failed. Your visits remain saved on this device. ${error.message}`, true);
  } finally {
    syncing = false;
    syncButton.disabled = false;
  }
}

async function resetInterruptedSyncs() {
  for (const record of await getAllRecords()) {
    if (record.sync_status === 'Syncing') await updateRecord(record.local_id, { sync_status: 'Pending' });
  }
}

syncButton.addEventListener('click', syncQueue);
window.addEventListener('online', () => {
  setNetworkStatus();
  checkServer();
  syncQueue();
});
window.addEventListener('offline', () => {
  setNetworkStatus();
  serverStatus.textContent = 'Server unreachable offline';
});

async function startApp() {
  setNetworkStatus();
  try {
    if (!('indexedDB' in window)) throw new Error('This browser does not support local record storage.');
    database = await openDatabase();
    await resetInterruptedSyncs();
    await renderRecords();
    await checkServer();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    if (navigator.onLine) syncQueue();
  } catch (error) {
    showNotice(`App setup problem: ${error.message}`, true);
  }
}

startApp();
