/* 買い物リスト — アプリ本体
   データはすべてこの端末の中（IndexedDB）に保存し、外部へは送信しません。 */
(() => {
  'use strict';

  const APP_VERSION = '1.0.0';
  const DB_NAME = 'kaimono-list';
  const DB_VERSION = 1;
  const BACKUP_APP = 'kaimono-list';
  const FORMAT_VERSION = 1;
  const OTHER_ID = 'other';
  const DAY = 24 * 60 * 60 * 1000;
  const BACKUP_REMIND_DAYS = 30;

  const PHOTO_MAX = 1200;
  const PHOTO_QUALITY = 0.8;
  const THUMB_MAX = 200;
  const THUMB_QUALITY = 0.72;

  const GROUP_LABELS = { food: '食品', nonfood: '食品以外', none: '区分なし' };

  const DEFAULT_CATEGORIES = [
    ['veg', '野菜・果物', 'food'],
    ['meat', '肉・魚', 'food'],
    ['chilled', '冷蔵・冷凍', 'food'],
    ['staple', '主食・調味料', 'food'],
    ['drink', '飲料・お菓子', 'food'],
    ['daily', '日用品・消耗品', 'nonfood'],
    ['clothes', '衣類・身の回り', 'nonfood'],
    ['machine', '家電・機械・工具', 'nonfood'],
    ['hobby', '本・趣味', 'nonfood'],
    [OTHER_ID, 'その他', 'none']
  ];

  /* ========== 小さな道具 ========== */

  const $ = (id) => document.getElementById(id);

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else node.setAttribute(key, value === true ? '' : String(value));
      }
    }
    for (const kid of kids) if (kid !== null && kid !== undefined) node.append(kid);
    return node;
  }

  class UserError extends Error {}

  function newId() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function cleanText(value, max) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
      .replace(/[ \t　]+/g, ' ')
      .trim()
      .slice(0, max);
  }

  const cleanName = (value) => cleanText(value, 60).replace(/\n/g, ' ');
  const cleanMemo = (value) => cleanText(value, 200);

  // 名前の比較用：全角半角・大文字小文字・ひらがなカタカナの違いを無視する
  function normName(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
  }

  function formatDate(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function base64ToBuffer(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  /* ========== 端末内データベース（IndexedDB） ========== */

  let db = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const d = request.result;
        if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('categories')) d.createObjectStore('categories', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('nameMap')) d.createObjectStore('nameMap', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      };
      request.onsuccess = () => {
        const d = request.result;
        d.onversionchange = () => d.close();
        resolve(d);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('blocked'));
    });
  }

  function dbGetAll(store) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(store, 'readonly').objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function dbGet(store, key) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(store, 'readonly').objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // 複数の保存をひとまとめに行う（途中で失敗したら全部なかったことになる）
  function dbWrite(stores, work) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('abort'));
      work((name) => tx.objectStore(name));
    });
  }

  /* ========== 状態 ========== */

  const state = {
    items: [],
    cats: [],
    nameMap: new Map(),
    meta: { filter: 'all', doneOpen: true, lastBackupAt: null, firstUsedAt: null, tipClosed: false },
    search: '',
    searchOpen: false,
    persisted: null
  };

  const isStandalone = () =>
    window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

  async function loadState() {
    const [items, cats, names, meta] = await Promise.all([
      dbGetAll('items'), dbGetAll('categories'), dbGetAll('nameMap'), dbGetAll('meta')
    ]);

    if (!cats.length) {
      const seeded = DEFAULT_CATEGORIES.map(([id, name, group], index) => ({ id, name, group, order: index }));
      await dbWrite(['categories'], (s) => seeded.forEach((c) => s('categories').put(c)));
      cats.push(...seeded);
    }
    if (!cats.some((c) => c.id === OTHER_ID)) {
      const other = { id: OTHER_ID, name: 'その他', group: 'none', order: 999999 };
      await dbWrite(['categories'], (s) => s('categories').put(other));
      cats.push(other);
    }

    state.cats = cats;
    const catIds = new Set(cats.map((c) => c.id));
    state.items = items.map((it) => (catIds.has(it.catId) ? it : { ...it, catId: OTHER_ID }));
    state.nameMap = new Map(names.map((n) => [n.key, n]));

    for (const row of meta) {
      if (row && Object.prototype.hasOwnProperty.call(state.meta, row.key)) state.meta[row.key] = row.value;
    }
    if (!['all', 'food', 'nonfood'].includes(state.meta.filter)) state.meta.filter = 'all';
    if (!state.meta.firstUsedAt) await setMeta('firstUsedAt', Date.now());
  }

  async function setMeta(key, value) {
    state.meta[key] = value;
    await dbWrite(['meta'], (s) => s('meta').put({ key, value }));
  }

  function sortedCats() {
    const rest = state.cats.filter((c) => c.id !== OTHER_ID).sort((a, b) => a.order - b.order);
    const other = state.cats.find((c) => c.id === OTHER_ID);
    return other ? [...rest, other] : rest;
  }

  const catById = (id) => state.cats.find((c) => c.id === id) || state.cats.find((c) => c.id === OTHER_ID);
  const itemById = (id) => state.items.find((it) => it.id === id);
  const itemByName = (name, exceptId) => {
    const key = normName(name);
    return state.items.find((it) => it.id !== exceptId && normName(it.name) === key);
  };

  function inFilter(item) {
    if (state.meta.filter === 'all') return true;
    const group = catById(item.catId).group;
    return group === 'none' || group === state.meta.filter;
  }

  function replaceItem(updated) {
    const index = state.items.findIndex((it) => it.id === updated.id);
    if (index >= 0) state.items[index] = updated;
    else state.items.push(updated);
  }

  /* ========== お知らせ（トースト）と確認ダイアログ ========== */

  let toastTimer = 0;
  let toastHandler = null;

  function overlayOpen() {
    return !$('settings').hidden || !$('sheet').hidden;
  }

  function toast(message, options) {
    const opts = options || {};
    clearTimeout(toastTimer);
    const box = $('toast');
    box.hidden = true;
    $('toastMsg').textContent = message;
    const action = $('toastAction');
    if (opts.action) {
      action.textContent = opts.action;
      action.hidden = false;
      toastHandler = opts.onAction || null;
    } else {
      action.hidden = true;
      toastHandler = null;
    }
    box.style.bottom = overlayOpen()
      ? 'calc(env(safe-area-inset-bottom, 0px) + 20px)'
      : `${$('bottomWrap').offsetHeight + 12}px`;
    box.hidden = false;
    toastTimer = setTimeout(hideToast, opts.duration || 3200);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    $('toast').hidden = true;
    toastHandler = null;
  }

  let dialogResolve = null;

  // buttons: [{ label, value, kind, onClick }]  kind は見た目（primary / danger-solid / plain など）
  function askDialog({ title, message, buttons }) {
    return new Promise((resolve) => {
      if (dialogResolve) dialogResolve(null);
      dialogResolve = resolve;
      $('dialogTitle').textContent = title;
      $('dialogMsg').textContent = message || '';
      $('dialogMsg').hidden = !message;
      const nodes = buttons.map((b) => {
        const btn = el('button', { type: 'button', class: `btn ${b.kind || 'plain'}`, text: b.label });
        btn.addEventListener('click', () => {
          // 共有シートなどは「タップした瞬間」に呼ぶ必要があるので、ここで直接実行する
          if (b.onClick) b.onClick();
          closeDialog(b.value);
        });
        return btn;
      });
      $('dialogButtons').replaceChildren(...nodes);
      $('dialogBackdrop').hidden = false;
    });
  }

  function closeDialog(value) {
    $('dialogBackdrop').hidden = true;
    const resolve = dialogResolve;
    dialogResolve = null;
    if (resolve) resolve(value === undefined ? null : value);
  }

  const confirmDialog = (title, message, okLabel, danger) =>
    askDialog({
      title,
      message,
      buttons: [
        { label: okLabel, value: true, kind: danger ? 'danger-solid' : 'primary' },
        { label: 'キャンセル', value: false, kind: 'plain' }
      ]
    }).then((v) => v === true);

  function describeError(error) {
    if (error instanceof UserError) return error.message;
    if (error && error.name === 'QuotaExceededError') return 'iPhoneの空き容量が足りず、保存できませんでした。';
    return 'うまく処理できませんでした。もう一度お試しください。';
  }

  // 画面操作の入口。失敗したら理由を画面に出す
  function guard(fn) {
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        if (!(error instanceof UserError)) console.error(error);
        toast(describeError(error), { duration: 5000 });
        return undefined;
      }
    };
  }

  /* ========== リスト画面の表示 ========== */

  function itemMatchesSearch(item, query) {
    return !query || normName(item.name).includes(query);
  }

  function renderRow(item) {
    const done = item.status === 'done';
    const row = el('li', { class: `row${done ? ' is-done' : ''}`, 'data-id': item.id });

    const check = el('button', {
      type: 'button',
      class: 'check',
      'data-action': 'toggle',
      'aria-pressed': done ? 'true' : 'false',
      'aria-label': done ? `${item.name}を「買う」に戻す` : `${item.name}を「買った」にする`
    }, el('span', { class: 'check-mark' }));
    row.append(check);

    if (item.thumb) {
      const img = el('img', { alt: '', decoding: 'async' });
      img.src = item.thumb;
      row.append(el('button', {
        type: 'button', class: 'thumb', 'data-action': 'photo', 'aria-label': `${item.name}の写真を大きく表示`
      }, img));
    }

    const name = el('span', { class: 'row-name' }, el('span', { class: 'row-name-text', text: item.name }));
    if (item.kind === 'regular') name.append(el('span', { class: 'stamp', text: '定番' }));
    const body = el('button', {
      type: 'button', class: 'row-body', 'data-action': 'edit', 'aria-label': `${item.name}を編集`
    }, name);
    if (item.memo) body.append(el('span', { class: 'row-memo', text: item.memo }));
    row.append(body);
    return row;
  }

  function renderGroups(items) {
    const frag = document.createDocumentFragment();
    for (const cat of sortedCats()) {
      const own = items.filter((it) => it.catId === cat.id).sort((a, b) => a.createdAt - b.createdAt);
      if (!own.length) continue;
      const head = el('h2', { class: `group-head g-${cat.group}` },
        el('span', { text: cat.name }),
        el('span', { class: 'group-count', text: `${own.length}件` }));
      const rows = el('ul', { class: 'rows' });
      own.forEach((it) => rows.append(renderRow(it)));
      frag.append(el('section', { class: 'group' }, head, rows));
    }
    return frag;
  }

  function renderList() {
    const list = $('list');
    const query = state.searchOpen ? normName(state.search) : '';
    const visible = state.items.filter((it) => inFilter(it) && itemMatchesSearch(it, query));
    const todo = visible.filter((it) => it.status !== 'done');
    const done = visible.filter((it) => it.status === 'done');
    const frag = document.createDocumentFragment();

    $('remain').textContent = `残り ${todo.length}件`;

    if (!isStandalone() && 'standalone' in window.navigator && !state.meta.tipClosed) {
      frag.append(el('div', { class: 'tip' },
        el('p', { text: 'ホーム画面に追加してから使い始めてください。Safariで開いた時とは、データの保存場所が別になります。追加方法は「設定」にあります。' }),
        el('button', { type: 'button', 'data-action': 'close-tip', text: '閉じる' })));
    }

    if (!state.items.length) {
      frag.append(el('div', { class: 'empty' },
        el('strong', { text: 'まだ何もありません' }),
        el('p', { text: '下の欄に品名を入れて「＋追加」を押すと、ここに並びます。' })));
    } else if (!todo.length) {
      const message = query
        ? '「買うもの」に、その名前の品はありません。'
        : state.meta.filter === 'all'
          ? '買うものは、いまありません。'
          : `「${GROUP_LABELS[state.meta.filter]}」で買うものは、いまありません。`;
      frag.append(el('div', { class: 'empty' }, el('p', { text: message })));
    } else {
      frag.append(renderGroups(todo));
    }

    if (done.length) {
      const open = state.meta.doneOpen || !!query;
      frag.append(el('button', {
        type: 'button', class: 'done-toggle', 'data-action': 'toggle-done', 'aria-expanded': open ? 'true' : 'false'
      },
      el('span', { text: '買ったもの・在庫あり' }),
      el('span', { class: 'group-count', text: `${done.length}件` })));
      if (open) frag.append(renderGroups(done));
    }

    list.replaceChildren(frag);

    $('btnFinish').disabled = !state.items.some((it) => it.kind === 'once' && it.status === 'done');
    document.querySelectorAll('#filterSeg button').forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.dataset.filter === state.meta.filter ? 'true' : 'false');
    });
    updateBackupReminder();
  }

  function flashRow(id) {
    const row = Array.from(document.querySelectorAll('#list .row')).find((r) => r.dataset.id === id);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1300);
  }

  // 今の絞り込みでは見えない品を追加・復活させた時の案内
  function noticeIfHidden(item, message) {
    if (inFilter(item)) {
      toast(message);
      return;
    }
    toast(`${message}（今の絞り込みでは表示されません）`, {
      action: 'すべて表示',
      duration: 6000,
      onAction: guard(async () => {
        await setMeta('filter', 'all');
        renderList();
        flashRow(item.id);
      })
    });
  }

  /* ========== 品目の操作 ========== */

  async function rememberName(name, catId) {
    const key = normName(name);
    if (!key) return;
    const record = { key, name, catId, usedAt: Date.now() };
    state.nameMap.set(key, record);
    await dbWrite(['nameMap'], (s) => s('nameMap').put(record));
  }

  function rememberedCat(name) {
    const record = state.nameMap.get(normName(name));
    if (record && state.cats.some((c) => c.id === record.catId)) return record.catId;
    return null;
  }

  async function saveItem(item, photoChange) {
    await dbWrite(['items', 'photos'], (s) => {
      s('items').put(item);
      if (photoChange) s('photos').put({ id: item.id, type: 'image/jpeg', data: photoChange.buf });
      else if (photoChange === null) s('photos').delete(item.id);
    });
    replaceItem(item);
  }

  async function createItem({ name, catId, kind, memo, photo }) {
    const now = Date.now();
    const item = {
      id: newId(),
      name,
      catId: catId || OTHER_ID,
      kind: kind === 'regular' ? 'regular' : 'once',
      memo: memo || '',
      status: 'todo',
      thumb: photo ? photo.thumb : null,
      hasPhoto: !!photo,
      createdAt: now,
      updatedAt: now,
      doneAt: null
    };
    await saveItem(item, photo || undefined);
    await rememberName(name, item.catId);
    return item;
  }

  async function setStatus(item, status) {
    const updated = { ...item, status, doneAt: status === 'done' ? Date.now() : null, updatedAt: Date.now() };
    await saveItem(updated);
    return updated;
  }

  // すばやく追加：同じ名前の品があれば新しく作らず、その品を「買う」に戻す
  async function quickAdd(rawName) {
    const name = cleanName(rawName);
    if (!name) return false;
    const existing = itemByName(name);
    if (existing) {
      if (existing.status === 'done') {
        const updated = await setStatus(existing, 'todo');
        renderList();
        noticeIfHidden(updated, `「${existing.name}」を「買う」に戻しました`);
      } else {
        renderList();
        noticeIfHidden(existing, `「${existing.name}」はもうリストにあります`);
      }
      flashRow(existing.id);
      return true;
    }
    const item = await createItem({ name, catId: rememberedCat(name), kind: 'once' });
    renderList();
    if (!inFilter(item)) noticeIfHidden(item, `「${item.name}」を追加しました`);
    flashRow(item.id);
    return true;
  }

  async function toggleItem(id) {
    const item = itemById(id);
    if (!item) return;
    await setStatus(item, item.status === 'done' ? 'todo' : 'done');
    renderList();
  }

  async function deleteItems(ids) {
    await dbWrite(['items', 'photos'], (s) => {
      ids.forEach((id) => {
        s('items').delete(id);
        s('photos').delete(id);
      });
    });
    const gone = new Set(ids);
    state.items = state.items.filter((it) => !gone.has(it.id));
  }

  async function finishShopping() {
    const targets = state.items.filter((it) => it.kind === 'once' && it.status === 'done');
    if (!targets.length) return;
    const ok = await confirmDialog(
      'お買い物を終了しますか？',
      `買った単発の品 ${targets.length}件をリストから消します。定番の品は「買ったもの・在庫あり」に残ります。`,
      `${targets.length}件を消して終了`
    );
    if (!ok) return;

    // 「元に戻す」用に、消す前の写真も控えておく
    const photos = [];
    for (const it of targets) {
      if (!it.hasPhoto) continue;
      const photo = await dbGet('photos', it.id);
      if (photo) photos.push(photo);
    }
    await deleteItems(targets.map((it) => it.id));
    if (wakeWanted) setWake(false);
    renderList();

    toast(`${targets.length}件を消しました`, {
      action: '元に戻す',
      duration: 8000,
      onAction: guard(async () => {
        await dbWrite(['items', 'photos'], (s) => {
          targets.forEach((it) => s('items').put(it));
          photos.forEach((p) => s('photos').put(p));
        });
        targets.forEach(replaceItem);
        renderList();
        toast('元に戻しました');
      })
    });
  }

  /* ========== 写真 ========== */

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new UserError('この画像は読み込めませんでした。別の写真でお試しください。'));
      img.src = url;
    });
  }

  function drawScaled(source, width, height, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function canvasToJpeg(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new UserError('写真を変換できませんでした。'));
      }, 'image/jpeg', quality);
    });
  }

  // 写真をcanvasで描き直してJPEGにする。元ファイルの位置情報など（EXIF）はここで捨てられる
  async function processPhoto(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImage(url);
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      if (!width || !height) throw new UserError('この画像は読み込めませんでした。別の写真でお試しください。');
      const full = drawScaled(img, width, height, PHOTO_MAX);
      const jpeg = await canvasToJpeg(full, PHOTO_QUALITY);
      const small = drawScaled(full, full.width, full.height, THUMB_MAX);
      const thumb = small.toDataURL('image/jpeg', THUMB_QUALITY);
      const buf = await jpeg.arrayBuffer();
      full.width = full.height = 0;
      small.width = small.height = 0;
      return { buf, thumb };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  let viewerUrl = null;

  function openViewerBuffer(buffer) {
    closeViewer();
    viewerUrl = URL.createObjectURL(new Blob([buffer], { type: 'image/jpeg' }));
    $('viewerImg').src = viewerUrl;
    $('viewer').hidden = false;
  }

  async function openViewerItem(id) {
    const photo = await dbGet('photos', id);
    if (!photo) throw new UserError('写真が見つかりませんでした。');
    openViewerBuffer(photo.data);
  }

  function closeViewer() {
    $('viewer').hidden = true;
    $('viewerImg').removeAttribute('src');
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = null;
  }

  /* ========== 追加・編集シート ========== */

  let draft = null;

  function renderSheet() {
    const chips = sortedCats().map((cat) => el('button', {
      type: 'button',
      class: 'chip',
      'data-cat': cat.id,
      'aria-pressed': cat.id === draft.catId ? 'true' : 'false',
      text: cat.name
    }));
    $('fCats').replaceChildren(...chips);

    document.querySelectorAll('#fKind button').forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.dataset.kind === draft.kind ? 'true' : 'false');
    });

    const preview = $('fPhotoPreview');
    if (draft.thumb) {
      $('fPhotoImg').src = draft.thumb;
      preview.hidden = false;
    } else {
      $('fPhotoImg').removeAttribute('src');
      preview.hidden = true;
    }
    $('fPhotoRemove').hidden = !draft.thumb;
    $('fPhotoLabelText').textContent = draft.busy ? '写真を処理中…' : draft.thumb ? '写真を変える' : '写真を選ぶ・撮る';
    $('sheetSave').disabled = draft.busy;
  }

  function openSheet(item, presetName) {
    draft = {
      id: item ? item.id : null,
      catId: item ? item.catId : OTHER_ID,
      kind: item ? item.kind : 'once',
      catTouched: false,
      kindTouched: false,
      photo: undefined, // undefined=変更なし / null=外す / {buf, thumb}=新しい写真
      thumb: item ? item.thumb : null,
      busy: false
    };
    $('sheetTitle').textContent = item ? '品目を編集' : '品目を追加';
    $('fName').value = item ? item.name : (presetName || '');
    $('fMemo').value = item ? item.memo : '';
    $('fNameError').hidden = true;
    $('fDelete').hidden = !item;
    $('fPhotoInput').value = '';
    if (!item) applyRememberedCat();
    renderSheet();
    hideSuggest();
    hideToast();
    $('sheetBackdrop').hidden = false;
    $('sheet').hidden = false;
    document.querySelector('#sheet .sheet-body').scrollTop = 0;
    if (!item) $('fName').focus();
  }

  function closeSheet() {
    if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
    $('sheet').hidden = true;
    $('sheetBackdrop').hidden = true;
    draft = null;
  }

  // 以前と同じ名前なら、その時の分類を自動で入れる（自分で選んだ後は変えない）
  function applyRememberedCat() {
    if (!draft || draft.id || draft.catTouched) return;
    const catId = rememberedCat($('fName').value);
    const next = catId || OTHER_ID;
    if (next !== draft.catId) {
      draft.catId = next;
      renderSheet();
    }
  }

  function showNameError(message) {
    $('fNameError').textContent = message;
    $('fNameError').hidden = false;
    document.querySelector('#sheet .sheet-body').scrollTop = 0;
  }

  async function saveSheet() {
    if (!draft || draft.busy) return;
    const name = cleanName($('fName').value);
    const memo = cleanMemo($('fMemo').value);
    if (!name) {
      showNameError('名前を入れてください。');
      return;
    }

    if (draft.id) {
      const item = itemById(draft.id);
      if (!item) { closeSheet(); return; }
      if (itemByName(name, item.id)) {
        showNameError('同じ名前の品がすでにあります。');
        return;
      }
      const updated = { ...item, name, catId: draft.catId, kind: draft.kind, memo, updatedAt: Date.now() };
      if (draft.photo !== undefined) {
        updated.thumb = draft.photo ? draft.photo.thumb : null;
        updated.hasPhoto = !!draft.photo;
      }
      await saveItem(updated, draft.photo);
      await rememberName(name, updated.catId);
      closeSheet();
      renderList();
      return;
    }

    const existing = itemByName(name);
    if (existing) {
      // 登録済みの品は新しく作らず、入力した内容をその品に反映して「買う」に入れる
      const updated = { ...existing, status: 'todo', doneAt: null, updatedAt: Date.now() };
      if (draft.catTouched) updated.catId = draft.catId;
      if (draft.kindTouched) updated.kind = draft.kind;
      if (memo) updated.memo = memo;
      if (draft.photo) {
        updated.thumb = draft.photo.thumb;
        updated.hasPhoto = true;
      }
      await saveItem(updated, draft.photo || undefined);
      await rememberName(updated.name, updated.catId);
      closeSheet();
      renderList();
      noticeIfHidden(updated, `「${updated.name}」は登録済みのため、その品を「買う」に入れました`);
      flashRow(updated.id);
      return;
    }

    const item = await createItem({ name, catId: draft.catId, kind: draft.kind, memo, photo: draft.photo || null });
    closeSheet();
    renderList();
    if (!inFilter(item)) noticeIfHidden(item, `「${item.name}」を追加しました`);
    flashRow(item.id);
  }

  async function deleteFromSheet() {
    if (!draft || !draft.id) return;
    const item = itemById(draft.id);
    if (!item) { closeSheet(); return; }
    const ok = await confirmDialog(`「${item.name}」を削除しますか？`, '写真とメモも一緒に消えます。元には戻せません。', '削除する', true);
    if (!ok) return;
    await deleteItems([item.id]);
    closeSheet();
    renderList();
    toast(`「${item.name}」を削除しました`);
  }

  async function onPhotoChosen(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file || !draft) return;
    const mine = draft;
    mine.busy = true;
    renderSheet();
    try {
      const photo = await processPhoto(file);
      if (draft !== mine) return;
      mine.photo = photo;
      mine.thumb = photo.thumb;
    } finally {
      mine.busy = false;
      if (draft === mine) renderSheet();
    }
  }

  /* ========== 入力中の候補 ========== */

  function hideSuggest() {
    $('suggest').hidden = true;
    $('suggest').replaceChildren();
  }

  function renderSuggest() {
    const query = normName($('quickInput').value);
    if (!query) { hideSuggest(); return; }

    const found = [];
    const present = new Set();
    for (const it of state.items) {
      const key = normName(it.name);
      present.add(key);
      const pos = key.indexOf(query);
      if (pos < 0) continue;
      found.push({
        type: it.status === 'done' ? 'stock' : 'listed',
        name: it.name, id: it.id, head: pos === 0 ? 0 : 1, time: it.updatedAt || 0
      });
    }
    for (const record of state.nameMap.values()) {
      if (present.has(record.key)) continue;
      const pos = record.key.indexOf(query);
      if (pos < 0) continue;
      found.push({ type: 'history', name: record.name, key: record.key, head: pos === 0 ? 0 : 1, time: record.usedAt || 0 });
    }
    if (!found.length) { hideSuggest(); return; }

    const order = { stock: 0, history: 1, listed: 2 };
    const notes = { stock: '在庫あり → 買うに戻す', history: '前に登録した品', listed: 'もうリストにあります' };
    found.sort((a, b) => a.head - b.head || order[a.type] - order[b.type] || b.time - a.time);

    const buttons = found.slice(0, 5).map((s) => {
      const btn = el('button', { type: 'button', 'data-type': s.type },
        el('span', { class: 's-name', text: s.name }),
        el('span', { class: 's-note', text: notes[s.type] }));
      btn.addEventListener('click', guard(() => chooseSuggestion(s)));
      return btn;
    });
    $('suggest').replaceChildren(...buttons);
    $('suggest').hidden = false;
  }

  async function chooseSuggestion(suggestion) {
    $('quickInput').value = '';
    hideSuggest();
    await quickAdd(suggestion.name);
  }

  /* ========== 設定：分類の編集 ========== */

  function groupButtons(cat) {
    const seg = el('div', { class: 'seg2', role: 'group', 'aria-label': `${cat.name}の区分` });
    for (const [group, label] of Object.entries(GROUP_LABELS)) {
      seg.append(el('button', {
        type: 'button', 'data-cat-action': 'group', 'data-group': group,
        'aria-pressed': cat.group === group ? 'true' : 'false', text: label
      }));
    }
    return seg;
  }

  function renderCatEditor() {
    const cats = sortedCats();
    const movable = cats.filter((c) => c.id !== OTHER_ID);
    const cards = cats.map((cat) => {
      const card = el('div', { class: 'cat-card', 'data-cat': cat.id });
      if (cat.id === OTHER_ID) {
        card.append(el('div', { class: 'cat-fixed' },
          el('span', { text: cat.name }),
          el('small', { text: '分類なしの品が入ります（変更・削除はできません）' })));
        return card;
      }
      const index = movable.indexOf(cat);
      const input = el('input', {
        type: 'text', class: 'cat-name', maxlength: '20', autocomplete: 'off', autocapitalize: 'off',
        'aria-label': '分類の名前', 'data-cat-action': 'rename'
      });
      input.value = cat.name;
      card.append(
        el('div', { class: 'cat-tools' },
          input,
          el('button', { type: 'button', class: 'mini-btn', 'data-cat-action': 'up', disabled: index === 0, 'aria-label': `${cat.name}を上へ`, text: '↑' }),
          el('button', { type: 'button', class: 'mini-btn', 'data-cat-action': 'down', disabled: index === movable.length - 1, 'aria-label': `${cat.name}を下へ`, text: '↓' })),
        el('div', { class: 'cat-tools' },
          groupButtons(cat),
          el('button', { type: 'button', class: 'mini-btn del', 'data-cat-action': 'delete', 'aria-label': `${cat.name}を削除`, text: '削除' })));
      return card;
    });
    $('catEditor').replaceChildren(...cards);
  }

  async function saveCats(cats) {
    await dbWrite(['categories'], (s) => cats.forEach((c) => s('categories').put(c)));
    for (const cat of cats) {
      const index = state.cats.findIndex((c) => c.id === cat.id);
      if (index >= 0) state.cats[index] = cat;
      else state.cats.push(cat);
    }
  }

  const catNameTaken = (name, exceptId) =>
    state.cats.some((c) => c.id !== exceptId && normName(c.name) === normName(name));

  async function renameCat(id, rawName, input) {
    const cat = state.cats.find((c) => c.id === id);
    if (!cat) return;
    const name = cleanText(rawName, 20).replace(/\n/g, ' ');
    if (name === cat.name) { input.value = cat.name; return; }
    if (!name) {
      input.value = cat.name;
      toast('分類の名前は空にできません');
      return;
    }
    if (catNameTaken(name, id)) {
      input.value = cat.name;
      toast(`「${name}」という分類はすでにあります`);
      return;
    }
    await saveCats([{ ...cat, name }]);
    input.value = name;
    renderList();
    toast('分類の名前を変えました');
  }

  async function moveCat(id, direction) {
    const movable = sortedCats().filter((c) => c.id !== OTHER_ID);
    const index = movable.findIndex((c) => c.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= movable.length) return;
    [movable[index], movable[target]] = [movable[target], movable[index]];
    await saveCats(movable.map((c, i) => ({ ...c, order: i })));
    renderCatEditor();
    renderList();
  }

  async function deleteCat(id) {
    const cat = state.cats.find((c) => c.id === id);
    if (!cat || id === OTHER_ID) return;
    const affected = state.items.filter((it) => it.catId === id);
    const ok = await confirmDialog(
      `分類「${cat.name}」を削除しますか？`,
      affected.length ? `この分類の品 ${affected.length}件は「その他」へ移します。品目は消えません。` : 'この分類の品はありません。',
      '削除する', true
    );
    if (!ok) return;
    const moved = affected.map((it) => ({ ...it, catId: OTHER_ID, updatedAt: Date.now() }));
    const names = Array.from(state.nameMap.values()).filter((n) => n.catId === id).map((n) => ({ ...n, catId: OTHER_ID }));
    await dbWrite(['categories', 'items', 'nameMap'], (s) => {
      s('categories').delete(id);
      moved.forEach((it) => s('items').put(it));
      names.forEach((n) => s('nameMap').put(n));
    });
    state.cats = state.cats.filter((c) => c.id !== id);
    moved.forEach(replaceItem);
    names.forEach((n) => state.nameMap.set(n.key, n));
    renderCatEditor();
    renderList();
    toast(`分類「${cat.name}」を削除しました`);
  }

  async function addCat(rawName) {
    const name = cleanText(rawName, 20).replace(/\n/g, ' ');
    if (!name) { toast('分類の名前を入れてください'); return false; }
    if (catNameTaken(name)) { toast(`「${name}」という分類はすでにあります`); return false; }
    const movable = sortedCats().filter((c) => c.id !== OTHER_ID);
    await saveCats([{ id: newId(), name, group: 'none', order: movable.length }]);
    renderCatEditor();
    toast('分類を追加しました。区分を選んでください');
    return true;
  }

  async function onCatEditorClick(event) {
    const btn = event.target.closest('button[data-cat-action]');
    if (!btn) return;
    const card = btn.closest('.cat-card');
    const id = card && card.dataset.cat;
    const action = btn.dataset.catAction;
    if (action === 'up') await moveCat(id, -1);
    else if (action === 'down') await moveCat(id, 1);
    else if (action === 'delete') await deleteCat(id);
    else if (action === 'group') {
      const cat = state.cats.find((c) => c.id === id);
      if (!cat || !GROUP_LABELS[btn.dataset.group]) return;
      await saveCats([{ ...cat, group: btn.dataset.group }]);
      renderCatEditor();
      renderList();
    }
  }

  /* ========== 設定：バックアップ ========== */

  function backupFileName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `kaimono-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
  }

  async function buildBackupBlob() {
    const head = {
      app: BACKUP_APP,
      formatVersion: FORMAT_VERSION,
      appVersion: APP_VERSION,
      exportedAt: new Date().toISOString(),
      categories: sortedCats().map((c, i) => ({ id: c.id, name: c.name, group: c.group, order: i })),
      nameMap: Array.from(state.nameMap.values()).map((n) => ({ name: n.name, catId: n.catId, usedAt: n.usedAt || 0 }))
    };
    // 写真が多くても一度に巨大な文字列を作らないよう、品目ごとに分けて組み立てる
    const parts = [JSON.stringify(head).slice(0, -1), ',"items":['];
    let first = true;
    for (const it of state.items) {
      let photo = null;
      if (it.hasPhoto) {
        const record = await dbGet('photos', it.id);
        if (record && record.data) photo = bufferToBase64(record.data);
      }
      const row = {
        id: it.id, name: it.name, catId: it.catId, kind: it.kind, memo: it.memo, status: it.status,
        createdAt: it.createdAt, updatedAt: it.updatedAt, doneAt: it.doneAt,
        thumb: photo ? it.thumb : null, photo
      };
      parts.push((first ? '' : ',') + JSON.stringify(row));
      first = false;
    }
    parts.push(']}');
    return new Blob(parts, { type: 'application/json' });
  }

  async function exportBackup() {
    toast('バックアップを準備しています…', { duration: 60000 });
    const blob = await buildBackupBlob();
    hideToast();
    const name = backupFileName();
    const file = new File([blob], name, { type: 'application/json' });
    const canShare = !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] }));
    const url = URL.createObjectURL(blob);
    let shared = null;

    const download = () => {
      const link = el('a', { href: url, download: name });
      document.body.append(link);
      link.click();
      link.remove();
    };

    const buttons = [];
    if (canShare) {
      buttons.push({
        label: '共有シートを開く', value: 'share', kind: 'primary',
        onClick: () => { shared = navigator.share({ files: [file] }); }
      });
    }
    buttons.push({ label: canShare ? 'ダウンロードする' : 'ファイルを保存する', value: 'download', kind: canShare ? 'outline' : 'primary', onClick: download });
    buttons.push({ label: 'やめる', value: null, kind: 'plain' });

    const choice = await askDialog({
      title: 'バックアップの準備ができました',
      message: `品目 ${state.items.length}件・${formatBytes(blob.size)}\n${canShare ? '共有シートで「"ファイル"に保存」を選ぶと、iPhoneの中やiCloud Driveに保存できます。' : 'ファイルとして保存します。'}`,
      buttons
    });

    try {
      if (choice === 'share' && shared) {
        try {
          await shared;
        } catch (error) {
          if (error && error.name === 'AbortError') return; // 共有をやめた
          throw new UserError('共有シートを開けませんでした。「ダウンロードする」をお試しください。');
        }
      } else if (choice !== 'download') {
        return;
      }
      await setMeta('lastBackupAt', Date.now());
      renderSettingsInfo();
      toast('バックアップを書き出しました');
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }

  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
  const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
  const THUMB_PREFIX = 'data:image/jpeg;base64,';

  function validThumb(value) {
    return typeof value === 'string' && value.length < 300000 && value.startsWith(THUMB_PREFIX) &&
      BASE64_PATTERN.test(value.slice(THUMB_PREFIX.length));
  }

  function decodePhoto(value) {
    if (typeof value !== 'string' || !value.length || value.length > 8000000 || !BASE64_PATTERN.test(value)) return null;
    let buffer;
    try { buffer = base64ToBuffer(value); } catch (error) { return null; }
    const head = new Uint8Array(buffer, 0, Math.min(3, buffer.byteLength));
    if (head.length < 3 || head[0] !== 0xFF || head[1] !== 0xD8 || head[2] !== 0xFF) return null; // JPEGだけ受け付ける
    return buffer;
  }

  const safeTime = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

  // バックアップの中身を検査し、知っている項目だけを取り出す
  async function parseBackup(text) {
    let data;
    try { data = JSON.parse(text); } catch (error) {
      throw new UserError('ファイルを読み取れませんでした。バックアップのファイルか確認してください。');
    }
    if (!isObject(data) || data.app !== BACKUP_APP) throw new UserError('このアプリのバックアップではありません。');
    if (!Number.isInteger(data.formatVersion) || data.formatVersion < 1) throw new UserError('バックアップの形式が正しくありません。');
    if (data.formatVersion > FORMAT_VERSION) throw new UserError('新しい版のアプリで作られたバックアップです。アプリを更新してから読み込んでください。');
    if (!Array.isArray(data.items) || !Array.isArray(data.categories)) throw new UserError('バックアップの形式が正しくありません。');
    if (data.items.length > 5000 || data.categories.length > 200) throw new UserError('バックアップの件数が多すぎます。');

    const now = Date.now();
    const cats = [];
    const catIdMap = new Map();
    const usedCatIds = new Set([OTHER_ID]);
    const usedCatNames = new Set(['その他'].map(normName));
    data.categories.forEach((raw, index) => {
      if (!isObject(raw)) return;
      if (raw.id === OTHER_ID) { catIdMap.set(OTHER_ID, OTHER_ID); return; }
      const name = cleanText(raw.name, 20).replace(/\n/g, ' ');
      if (!name || usedCatNames.has(normName(name))) return;
      let id = typeof raw.id === 'string' && ID_PATTERN.test(raw.id) && !usedCatIds.has(raw.id) ? raw.id : newId();
      usedCatIds.add(id);
      usedCatNames.add(normName(name));
      if (typeof raw.id === 'string') catIdMap.set(raw.id, id);
      cats.push({
        id, name,
        group: Object.prototype.hasOwnProperty.call(GROUP_LABELS, raw.group) ? raw.group : 'none',
        order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : index
      });
    });
    cats.sort((a, b) => a.order - b.order).forEach((c, i) => { c.order = i; });
    cats.push({ id: OTHER_ID, name: 'その他', group: 'none', order: 999999 });

    const items = [];
    const usedIds = new Set();
    const usedNames = new Set();
    let skipped = 0;
    let photoCount = 0;
    for (const raw of data.items) {
      if (!isObject(raw)) { skipped++; continue; }
      const name = cleanName(raw.name);
      if (!name || usedNames.has(normName(name))) { skipped++; continue; }
      usedNames.add(normName(name));
      let id = typeof raw.id === 'string' && ID_PATTERN.test(raw.id) && !usedIds.has(raw.id) ? raw.id : newId();
      usedIds.add(id);
      const photo = decodePhoto(raw.photo);
      let thumb = photo && validThumb(raw.thumb) ? raw.thumb : null;
      let buf = photo;
      if (photo && !thumb) {
        // サムネイルが無い・壊れている時は写真から作り直す
        try {
          const remade = await processPhoto(new Blob([photo], { type: 'image/jpeg' }));
          thumb = remade.thumb;
          buf = remade.buf;
        } catch (error) { buf = null; thumb = null; }
      }
      if (buf) photoCount++;
      const createdAt = safeTime(raw.createdAt, now);
      const status = raw.status === 'done' ? 'done' : 'todo';
      items.push({
        item: {
          id, name,
          catId: catIdMap.get(raw.catId) || OTHER_ID,
          kind: raw.kind === 'regular' ? 'regular' : 'once',
          memo: cleanMemo(typeof raw.memo === 'string' ? raw.memo : ''),
          status,
          thumb: buf ? thumb : null,
          hasPhoto: !!buf,
          createdAt,
          updatedAt: safeTime(raw.updatedAt, createdAt),
          doneAt: status === 'done' ? safeTime(raw.doneAt, now) : null
        },
        buf
      });
    }

    const names = [];
    const seenKeys = new Set();
    if (Array.isArray(data.nameMap)) {
      for (const raw of data.nameMap.slice(0, 5000)) {
        if (!isObject(raw)) continue;
        const name = cleanName(raw.name);
        const key = normName(name);
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);
        names.push({ key, name, catId: catIdMap.get(raw.catId) || OTHER_ID, usedAt: safeTime(raw.usedAt, now) });
      }
    }

    return { cats, items, names, skipped, photoCount, exportedAt: Date.parse(data.exportedAt) || null };
  }

  async function applyReplace(backup) {
    await dbWrite(['items', 'photos', 'categories', 'nameMap'], (s) => {
      ['items', 'photos', 'categories', 'nameMap'].forEach((name) => s(name).clear());
      backup.cats.forEach((c) => s('categories').put(c));
      backup.items.forEach(({ item, buf }) => {
        s('items').put(item);
        if (buf) s('photos').put({ id: item.id, type: 'image/jpeg', data: buf });
      });
      backup.names.forEach((n) => s('nameMap').put(n));
    });
    return { added: backup.items.length, same: 0 };
  }

  async function applyMerge(backup) {
    const catMap = new Map([[OTHER_ID, OTHER_ID]]);
    const newCats = [];
    let order = sortedCats().filter((c) => c.id !== OTHER_ID).length;
    for (const cat of backup.cats) {
      if (cat.id === OTHER_ID) continue;
      const same = state.cats.find((c) => normName(c.name) === normName(cat.name));
      if (same) { catMap.set(cat.id, same.id); continue; }
      const created = { id: newId(), name: cat.name, group: cat.group, order: order++ };
      newCats.push(created);
      catMap.set(cat.id, created.id);
    }

    const existingNames = new Set(state.items.map((it) => normName(it.name)));
    const toAdd = [];
    let same = 0;
    for (const { item, buf } of backup.items) {
      if (existingNames.has(normName(item.name))) { same++; continue; }
      toAdd.push({ item: { ...item, id: newId(), catId: catMap.get(item.catId) || OTHER_ID }, buf });
    }
    const names = backup.names
      .filter((n) => !state.nameMap.has(n.key))
      .map((n) => ({ ...n, catId: catMap.get(n.catId) || OTHER_ID }));

    await dbWrite(['items', 'photos', 'categories', 'nameMap'], (s) => {
      newCats.forEach((c) => s('categories').put(c));
      toAdd.forEach(({ item, buf }) => {
        s('items').put(item);
        if (buf) s('photos').put({ id: item.id, type: 'image/jpeg', data: buf });
      });
      names.forEach((n) => s('nameMap').put(n));
    });
    return { added: toAdd.length, same };
  }

  async function importBackup(file) {
    if (file.size > 300 * 1024 * 1024) throw new UserError('ファイルが大きすぎます。');
    toast('バックアップを確認しています…', { duration: 60000 });
    let backup;
    try {
      backup = await parseBackup(await file.text());
    } finally {
      hideToast();
    }
    if (!backup.items.length && backup.cats.length <= 1) throw new UserError('このバックアップには品目がありません。');

    const lines = [`品目 ${backup.items.length}件（写真 ${backup.photoCount}枚）・分類 ${backup.cats.length}件`];
    if (backup.exportedAt) lines.push(`書き出した日：${formatDate(backup.exportedAt)}`);
    if (backup.skipped) lines.push(`読み取れない、または重複した ${backup.skipped}件は除きます。`);
    lines.push('', '置き換え：今のデータを消して、バックアップの内容にします。', '追加：今のデータに、バックアップの品目を足します（同じ名前の品は足しません）。');

    const mode = await askDialog({
      title: 'バックアップを読み込みます',
      message: lines.join('\n'),
      buttons: [
        { label: '追加する', value: 'merge', kind: 'primary' },
        { label: '置き換える', value: 'replace', kind: 'danger-outline' },
        { label: 'キャンセル', value: null, kind: 'plain' }
      ]
    });
    if (!mode) return;
    if (mode === 'replace' && state.items.length) {
      const ok = await confirmDialog('今のデータを消して置き換えますか？', `今ある品目 ${state.items.length}件と写真は消えます。元には戻せません。`, '置き換える', true);
      if (!ok) return;
    }

    const result = mode === 'replace' ? await applyReplace(backup) : await applyMerge(backup);
    await loadState();
    renderList();
    renderCatEditor();
    renderSettingsInfo();
    toast(mode === 'replace'
      ? `バックアップの内容に置き換えました（品目 ${result.added}件）`
      : `${result.added}件を追加しました${result.same ? `（同じ名前の ${result.same}件は足していません）` : ''}`,
    { duration: 5000 });
  }

  /* ========== 設定：そのほか ========== */

  function backupIsOld() {
    if (!state.items.length) return false;
    const base = state.meta.lastBackupAt || state.meta.firstUsedAt;
    return !!base && Date.now() - base > BACKUP_REMIND_DAYS * DAY;
  }

  function updateBackupReminder() {
    $('settingsDot').hidden = !backupIsOld();
  }

  async function renderSettingsInfo() {
    $('backupInfo').textContent = state.meta.lastBackupAt
      ? `前回の書き出し：${formatDate(state.meta.lastBackupAt)}`
      : 'まだ書き出していません。';
    $('backupWarn').hidden = !backupIsOld();
    updateBackupReminder();
    $('versionInfo').textContent = `買い物リスト バージョン ${APP_VERSION}`;

    const photos = state.items.filter((it) => it.hasPhoto).length;
    let text = `品目 ${state.items.length}件・写真 ${photos}枚`;
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        if (typeof estimate.usage === 'number') text = `約 ${formatBytes(estimate.usage)} を使用（${text}）`;
      }
      if (navigator.storage && navigator.storage.persisted) state.persisted = await navigator.storage.persisted();
    } catch (error) { /* 容量を調べられない端末では件数だけ表示する */ }
    if (state.persisted === true) text += '\n保存の保護：有効（iPhoneが自動で消しにくい状態です）';
    else if (state.persisted === false) text += '\n保存の保護：未設定（ホーム画面に追加して使うと消えにくくなります）';
    $('storageInfo').textContent = text;
  }

  function openSettings() {
    hideSuggest();
    hideToast();
    renderCatEditor();
    renderSettingsInfo();
    $('settings').hidden = false;
    document.querySelector('#settings .panel-body').scrollTop = 0;
  }

  function closeSettings() {
    if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
    $('settings').hidden = true;
    hideToast();
    renderList();
  }

  async function clearHistory() {
    const ok = await confirmDialog('入力候補の記憶を消しますか？', '以前に登録した名前の候補と、名前ごとの分類の記憶を消します。今リストにある品目は消えません。', '消す', true);
    if (!ok) return;
    const keep = state.items.map((it) => ({ key: normName(it.name), name: it.name, catId: it.catId, usedAt: it.updatedAt || Date.now() }));
    await dbWrite(['nameMap'], (s) => {
      s('nameMap').clear();
      keep.forEach((n) => s('nameMap').put(n));
    });
    state.nameMap = new Map(keep.map((n) => [n.key, n]));
    toast('入力候補の記憶を消しました');
  }

  async function wipeAll() {
    const first = await confirmDialog('全データを削除しますか？', `品目 ${state.items.length}件と写真、分類の変更、入力候補をすべて消します。`, '削除へ進む', true);
    if (!first) return;
    const second = await confirmDialog('本当に削除しますか？', 'この操作は元に戻せません。必要なら、先にバックアップを書き出してください。', 'すべて削除する', true);
    if (!second) return;
    await dbWrite(['items', 'photos', 'categories', 'nameMap', 'meta'], (s) => {
      ['items', 'photos', 'categories', 'nameMap', 'meta'].forEach((name) => s(name).clear());
    });
    state.meta = { filter: 'all', doneOpen: true, lastBackupAt: null, firstUsedAt: null, tipClosed: false };
    state.search = '';
    await loadState();
    renderCatEditor();
    renderSettingsInfo();
    renderList();
    toast('全データを削除しました');
  }

  /* ========== 画面を消さない（対応している端末だけ） ========== */

  let wakeLock = null;
  let wakeWanted = false;

  function updateWakeButton() {
    $('btnWake').setAttribute('aria-pressed', wakeWanted ? 'true' : 'false');
  }

  async function setWake(on) {
    wakeWanted = on;
    if (on) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } catch (error) {
        wakeWanted = false;
        wakeLock = null;
        toast('この端末では、画面を点けたままにできませんでした');
      }
    } else if (wakeLock) {
      try { await wakeLock.release(); } catch (error) { /* すでに解除済み */ }
      wakeLock = null;
    }
    updateWakeButton();
  }

  /* ========== キーボード表示時の高さ合わせ ========== */

  function syncViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    if (vv.scale > 1.01) return; // 拡大表示中は触らない
    root.style.setProperty('--vv-h', `${vv.height}px`);
    root.style.setProperty('--vv-top', `${vv.offsetTop}px`);
    $('app').classList.toggle('kb-open', window.innerHeight - vv.height > 120);
  }

  /* ========== オフライン動作（Service Worker） ========== */

  function setupServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    let lastCheck = 0;
    const askRefresh = async () => {
      if (Date.now() - lastCheck < 60 * 60 * 1000) return; // 確認は1時間に1回まで
      lastCheck = Date.now();
      const ready = await navigator.serviceWorker.ready;
      if (ready.active) ready.active.postMessage({ type: 'refresh' });
    };
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'updated') {
        toast('新しい版を取得しました。次に開いた時から反映されます。', {
          action: '今すぐ反映',
          duration: 10000,
          onAction: () => window.location.reload()
        });
      }
    });
    const start = async () => {
      try {
        await navigator.serviceWorker.register('./sw.js');
        // 画面の表示が済んでから、裏で新しい版がないか確認してもらう
        await askRefresh();
      } catch (error) {
        console.warn('Service Workerを登録できませんでした', error);
      }
    };
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start);
    // アプリを閉じずに使い続けている場合も、画面に戻ってきた時に確認する
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') askRefresh().catch(() => {});
    });
  }

  /* ========== 画面の操作をつなぐ ========== */

  function bindEvents() {
    // リスト（行の中のボタンはまとめて受ける）
    $('list').addEventListener('click', guard(async (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      const row = target.closest('.row');
      const id = row && row.dataset.id;
      switch (target.dataset.action) {
        case 'toggle': await toggleItem(id); break;
        case 'photo': await openViewerItem(id); break;
        case 'edit': { const item = itemById(id); if (item) openSheet(item); break; }
        case 'toggle-done': await setMeta('doneOpen', !state.meta.doneOpen); renderList(); break;
        case 'close-tip': await setMeta('tipClosed', true); renderList(); break;
        default: break;
      }
    }));

    // 絞り込み
    $('filterSeg').addEventListener('click', guard(async (event) => {
      const btn = event.target.closest('button[data-filter]');
      if (!btn || btn.dataset.filter === state.meta.filter) return;
      await setMeta('filter', btn.dataset.filter);
      renderList();
      $('list').scrollTop = 0;
    }));

    // 名前でさがす
    const closeSearch = () => {
      state.searchOpen = false;
      state.search = '';
      $('searchInput').value = '';
      $('searchBar').hidden = true;
      $('btnSearch').setAttribute('aria-pressed', 'false');
      renderList();
    };
    $('btnSearch').addEventListener('click', () => {
      if (state.searchOpen) { closeSearch(); return; }
      state.searchOpen = true;
      $('searchBar').hidden = false;
      $('btnSearch').setAttribute('aria-pressed', 'true');
      $('searchInput').focus();
    });
    $('searchClose').addEventListener('click', closeSearch);
    $('searchInput').addEventListener('input', () => {
      state.search = $('searchInput').value;
      renderList();
    });
    $('searchInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) $('searchInput').blur();
    });

    // すばやく追加
    $('quickForm').addEventListener('submit', guard(async (event) => {
      event.preventDefault();
      const input = $('quickInput');
      const value = input.value;
      if (!cleanName(value)) {
        input.value = '';
        hideSuggest();
        openSheet(null);
        return;
      }
      input.value = '';
      hideSuggest();
      await quickAdd(value);
    }));
    $('quickInput').addEventListener('input', renderSuggest);
    $('quickInput').addEventListener('focus', renderSuggest);
    $('btnFinish').addEventListener('click', guard(finishShopping));

    // 追加・編集シート
    $('sheetCancel').addEventListener('click', closeSheet);
    $('sheetBackdrop').addEventListener('click', closeSheet);
    $('sheetSave').addEventListener('click', guard(saveSheet));
    $('fDelete').addEventListener('click', guard(deleteFromSheet));
    $('fName').addEventListener('input', () => {
      $('fNameError').hidden = true;
      applyRememberedCat();
    });
    $('fName').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) $('fName').blur();
    });
    $('fCats').addEventListener('click', (event) => {
      const chip = event.target.closest('button[data-cat]');
      if (!chip || !draft) return;
      draft.catId = chip.dataset.cat;
      draft.catTouched = true;
      renderSheet();
    });
    $('fKind').addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-kind]');
      if (!btn || !draft) return;
      draft.kind = btn.dataset.kind === 'regular' ? 'regular' : 'once';
      draft.kindTouched = true;
      renderSheet();
    });
    $('fPhotoInput').addEventListener('change', guard(onPhotoChosen));
    $('fPhotoRemove').addEventListener('click', () => {
      if (!draft) return;
      draft.photo = null;
      draft.thumb = null;
      renderSheet();
    });
    $('fPhotoPreview').addEventListener('click', guard(async () => {
      if (!draft) return;
      if (draft.photo) openViewerBuffer(draft.photo.buf);
      else if (draft.id && draft.photo === undefined) await openViewerItem(draft.id);
    }));

    // 写真の全画面表示
    $('viewer').addEventListener('click', closeViewer);

    // 設定
    $('btnSettings').addEventListener('click', openSettings);
    $('settingsClose').addEventListener('click', closeSettings);
    $('btnExport').addEventListener('click', guard(exportBackup));
    $('importInput').addEventListener('change', guard(async (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (file) await importBackup(file);
    }));
    $('catEditor').addEventListener('click', guard(onCatEditorClick));
    $('catEditor').addEventListener('change', guard(async (event) => {
      const input = event.target.closest('input[data-cat-action="rename"]');
      if (!input) return;
      await renameCat(input.closest('.cat-card').dataset.cat, input.value, input);
    }));
    $('catEditor').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing && event.target.matches('input')) event.target.blur();
    });
    $('catAddForm').addEventListener('submit', guard(async (event) => {
      event.preventDefault();
      if (await addCat($('catAddInput').value)) $('catAddInput').value = '';
    }));
    $('btnClearHistory').addEventListener('click', guard(clearHistory));
    $('btnWipe').addEventListener('click', guard(wipeAll));

    // お知らせ・ダイアログ
    $('toastAction').addEventListener('click', () => {
      const handler = toastHandler;
      hideToast();
      if (handler) handler();
    });
    $('dialogBackdrop').addEventListener('click', (event) => {
      if (event.target === $('dialogBackdrop')) closeDialog(null);
    });

    // 画面を消さない
    if ('wakeLock' in navigator) {
      $('btnWake').hidden = false;
      $('btnWake').addEventListener('click', guard(() => setWake(!wakeWanted)));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && wakeWanted && !wakeLock) setWake(true);
      });
    }

    // キーボードの出入りに合わせる
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncViewport);
      window.visualViewport.addEventListener('scroll', syncViewport);
    }
    window.addEventListener('orientationchange', () => setTimeout(syncViewport, 300));
  }

  function showFatal(message) {
    $('list').replaceChildren(el('div', { class: 'fatal' },
      el('strong', { text: 'データを開けませんでした' }),
      el('p', { text: message })));
  }

  async function init() {
    syncViewport();
    if (!('indexedDB' in window)) {
      showFatal('このブラウザーでは端末内への保存が使えません。iPhoneのSafariで開いてください。');
      return;
    }
    try {
      db = await openDB();
      await loadState();
    } catch (error) {
      console.error(error);
      showFatal('プライベートブラウズでは保存できないことがあります。通常のSafari、またはホーム画面のアイコンから開いてください。');
      return;
    }
    bindEvents();
    renderList();
    setupServiceWorker();

    // 端末がデータを自動で消しにくくなるよう、永続保存を要求する
    try {
      if (navigator.storage && navigator.storage.persist) state.persisted = await navigator.storage.persist();
    } catch (error) { /* 対応していない端末ではそのまま使う */ }
  }

  init();
})();
