/* ============================================================
   ГРОШІ — логіка застосунку
   ============================================================ */

const STORE = {
  tx: 'groshi_tx_v1',
  cats: 'groshi_custom_cats_v1',
  pin: 'groshi_pin_v1',
  meta: 'groshi_meta_v1',
  budgets: 'groshi_budgets_v1',
  ai: 'groshi_ai_v1',
  goal: 'groshi_goal_v1',
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------- State ---------- */
let transactions = [];
let customCats = { expense: [], income: [] };
let budgets = {};                // { categoryId: monthlyLimit }
let aiConfig = { key: '', model: 'claude-opus-4-8', enabled: false };
let goal = { name: 'Авто', target: 30000, saved: 0, deadline: '2027-04-01' };
let state = {
  addType: 'expense',
  addAmount: '0',
  addCat: null,
  addPhoto: null,
  analyticsPeriod: 'month',
  analyticsIO: 'expense',
  customFrom: null,
  customTo: null,
  calMonth: new Date().getFullYear() * 12 + new Date().getMonth(),
  calSelectedDay: null,
};

/* ---------- Storage ---------- */
function load() {
  try { transactions = JSON.parse(localStorage.getItem(STORE.tx)) || []; } catch { transactions = []; }
  try { customCats = JSON.parse(localStorage.getItem(STORE.cats)) || { expense: [], income: [] }; } catch {}
  try { budgets = JSON.parse(localStorage.getItem(STORE.budgets)) || {}; } catch { budgets = {}; }
  try { aiConfig = { ...aiConfig, ...(JSON.parse(localStorage.getItem(STORE.ai)) || {}) }; } catch {}
  try { const g = JSON.parse(localStorage.getItem(STORE.goal)); if (g) goal = { ...goal, ...g }; } catch {}
}
function saveTx() { localStorage.setItem(STORE.tx, JSON.stringify(transactions)); }
function saveCats() { localStorage.setItem(STORE.cats, JSON.stringify(customCats)); }
function saveBudgets() { localStorage.setItem(STORE.budgets, JSON.stringify(budgets)); }
function saveAi() { localStorage.setItem(STORE.ai, JSON.stringify(aiConfig)); }
function saveGoal() { localStorage.setItem(STORE.goal, JSON.stringify(goal)); }

/* ---------- Photo storage (IndexedDB) ---------- */
const PhotoDB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      if (this.db) return res(this.db);
      const r = indexedDB.open('groshi_photos', 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
        if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending');
      };
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  // --- черга чеків на розпізнавання ---
  async putPending(id, obj) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('pending', 'readwrite');
      tx.objectStore('pending').put(obj, id);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  },
  async getPending(id) {
    const db = await this.open();
    return new Promise((res) => {
      const tx = db.transaction('pending', 'readonly');
      const rq = tx.objectStore('pending').get(id);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => res(null);
    });
  },
  async allPending() {
    const db = await this.open();
    return new Promise((res) => {
      const out = [];
      const tx = db.transaction('pending', 'readonly');
      const cur = tx.objectStore('pending').openCursor();
      cur.onsuccess = (e) => { const c = e.target.result; if (c) { out.push({ id: c.key, ...c.value }); c.continue(); } else res(out); };
      cur.onerror = () => res(out);
    });
  },
  async delPending(id) {
    const db = await this.open();
    return new Promise((res) => {
      const tx = db.transaction('pending', 'readwrite');
      tx.objectStore('pending').delete(id);
      tx.oncomplete = () => res(); tx.onerror = () => res();
    });
  },
  async countPending() { return (await this.allPending()).length; },
  async put(id, dataUrl) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('photos', 'readwrite');
      tx.objectStore('photos').put(dataUrl, id);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  },
  async get(id) {
    const db = await this.open();
    return new Promise((res) => {
      const tx = db.transaction('photos', 'readonly');
      const rq = tx.objectStore('photos').get(id);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => res(null);
    });
  },
  async del(id) {
    const db = await this.open();
    return new Promise((res) => {
      const tx = db.transaction('photos', 'readwrite');
      tx.objectStore('photos').delete(id);
      tx.oncomplete = () => res(); tx.onerror = () => res();
    });
  },
  async all() {
    const db = await this.open();
    return new Promise((res) => {
      const out = {};
      const tx = db.transaction('photos', 'readonly');
      const cur = tx.objectStore('photos').openCursor();
      cur.onsuccess = (e) => { const c = e.target.result; if (c) { out[c.key] = c.value; c.continue(); } else res(out); };
      cur.onerror = () => res(out);
    });
  }
};

// Стиснення фото чека до compact JPEG (зменшує розмір у рази)
function compressImage(file, maxDim = 1280, quality = 0.72) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, maxDim / Math.max(width, height));
      width = Math.round(width * scale); height = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      try { res(canvas.toDataURL('image/jpeg', quality)); } catch (e) { rej(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('image load failed')); };
    img.src = url;
  });
}

function allCats(type) {
  return [...DEFAULT_CATEGORIES[type], ...(customCats[type] || [])];
}
function findCat(type, id) {
  return allCats(type).find(c => c.id === id) || { id, name: id, emoji: '🎯', color: '#8c90b8' };
}

/* ---------- Formatting ---------- */
const fmt = (n) => {
  const neg = n < 0;
  const v = Math.abs(Math.round(n * 100) / 100);
  const s = v.toLocaleString('uk-UA', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return (neg ? '−' : '') + s + ' ₴';
};
const fmtShort = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return (n/1e6).toFixed(1).replace('.0','') + 'М ₴';
  if (a >= 1e3) return (n/1e3).toFixed(1).replace('.0','') + 'К ₴';
  return Math.round(n) + ' ₴';
};
const MONTHS = ['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень'];
const MONTHS_GEN = ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];
const DOW = ['Пн','Вт','Ср','Чт','Пт','Сб','Нд'];

function ymd(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`;
}
function parseYmd(s) { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); }
function todayYmd() { return ymd(new Date()); }

/* ============================================================
   PIN LOCK
   ============================================================ */
const PIN = {
  buffer: '',
  mode: 'check',   // 'check' | 'set' | 'confirm' | 'change-old' | 'change-new' | 'change-confirm'
  firstEntry: '',
  onDone: null,

  init() {
    const has = !!localStorage.getItem(STORE.pin);
    this.show(has ? 'check' : 'set');
  },
  hashed(p) { // легке "хешування" — не криптографія, просто щоб не зберігати відкрито
    let h = 0; for (const c of (p + 'groshi-salt')) h = (h * 31 + c.charCodeAt(0)) | 0;
    return String(h);
  },
  show(mode, onDone) {
    this.mode = mode; this.buffer = ''; this.firstEntry = ''; this.onDone = onDone || null;
    $('#lockScreen').classList.remove('hidden');
    this.render();
    this.updateText();
  },
  updateText() {
    const map = {
      'check':        ['Введіть PIN-код', 'Доступ до ваших фінансів'],
      'set':          ['Створіть PIN-код', 'Запам\'ятайте його для входу'],
      'confirm':      ['Повторіть PIN-код', 'Підтвердіть новий код'],
      'change-old':   ['Поточний PIN-код', 'Введіть старий код'],
      'change-new':   ['Новий PIN-код', 'Придумайте новий код'],
      'change-confirm':['Повторіть код', 'Підтвердіть новий код'],
    };
    const [t, s] = map[this.mode] || map.check;
    $('#lockTitle').textContent = t; $('#lockSub').textContent = s;
  },
  render(err) {
    const dots = $$('#pinDots .pin-dot');
    dots.forEach((d, i) => d.classList.toggle('filled', i < this.buffer.length));
    $('#pinDots').classList.toggle('error', !!err);
    if (err) setTimeout(() => $('#pinDots').classList.remove('error'), 450);
  },
  press(key) {
    if (key === 'del') { this.buffer = this.buffer.slice(0, -1); this.render(); return; }
    if (this.buffer.length >= 4) return;
    this.buffer += key;
    this.render();
    if (this.buffer.length === 4) setTimeout(() => this.complete(), 120);
  },
  complete() {
    const entered = this.buffer;
    switch (this.mode) {
      case 'check':
        if (this.hashed(entered) === localStorage.getItem(STORE.pin)) { this.unlock(); }
        else { this.buffer = ''; this.render(true); }
        break;
      case 'set':
      case 'change-new':
        this.firstEntry = entered; this.buffer = '';
        this.mode = (this.mode === 'set') ? 'confirm' : 'change-confirm';
        this.updateText(); this.render();
        break;
      case 'confirm':
      case 'change-confirm':
        if (entered === this.firstEntry) {
          localStorage.setItem(STORE.pin, this.hashed(entered));
          if (this.mode === 'change-confirm') { this.hide(); toast('PIN-код змінено ✓'); if (this.onDone) this.onDone(); }
          else this.unlock();
        } else {
          this.buffer = ''; this.mode = (this.mode === 'confirm') ? 'set' : 'change-new';
          this.updateText(); this.render(true);
          toast('Коди не збігаються');
        }
        break;
      case 'change-old':
        if (this.hashed(entered) === localStorage.getItem(STORE.pin)) {
          this.buffer = ''; this.mode = 'change-new'; this.updateText(); this.render();
        } else { this.buffer = ''; this.render(true); }
        break;
    }
  },
  unlock() { this.hide(); refreshAll(); },
  hide() { $('#lockScreen').classList.add('hidden'); },
};

$('#pinPad').addEventListener('click', (e) => {
  const b = e.target.closest('.pin-key'); if (!b || b.classList.contains('blank')) return;
  PIN.press(b.dataset.act === 'del' ? 'del' : b.textContent.trim());
});

/* ============================================================
   NAVIGATION
   ============================================================ */
function goto(screen) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $('#screen-' + screen).classList.add('active');
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.goto === screen));
  window.scrollTo(0, 0);
  if (screen === 'home') renderHome();
  if (screen === 'calendar') renderCalendar();
  if (screen === 'analytics') renderAnalytics();
  if (screen === 'add') renderCategories();
  if (screen === 'settings') renderStats();
  if (screen === 'receipts') renderReceipts();
}
document.body.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-goto]');
  if (nav) goto(nav.dataset.goto);
});

/* ============================================================
   HOME
   ============================================================ */
function showWisdom() {
  const w = WISDOMS[Math.floor(Math.random() * WISDOMS.length)];
  $('#wisdomText').textContent = w.t;
  $('#wisdomAuthor').textContent = '— ' + w.a;
}

function monthsUntil(dateStr) {
  if (!dateStr) return 0;
  const now = new Date(); now.setHours(0,0,0,0);
  const d = parseYmd(dateStr);
  let m = (d.getFullYear() - now.getFullYear()) * 12 + (d.getMonth() - now.getMonth());
  if (d.getDate() < now.getDate()) m -= 1; // поточний місяць ще не «закрився»
  return m;
}
function fmtDate(dateStr) {
  const d = parseYmd(dateStr);
  return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
}
function updateGoalCard() {
  const saved = goal.saved || 0, target = goal.target || 0;
  $('#goalName').textContent = goal.name || 'Накопичення';
  $('#goalSaved').textContent = fmt(saved);
  $('#goalTarget').textContent = fmt(target);
  const ratio = target > 0 ? Math.min(1, saved / target) : 0;
  const pct = Math.round(ratio * 100);
  $('#goalBarFill').style.width = (ratio * 100) + '%';
  $('#goalPct').textContent = pct + '%';

  const remainEl = $('#goalRemain');
  const monthlyEl = $('#goalMonthly');
  const left = target - saved;

  if (target > 0 && left <= 0) {
    remainEl.classList.add('done');
    remainEl.innerHTML = `🎉 Ціль досягнута! Накопичено ${fmt(saved)} (${pct}%)`;
    monthlyEl.innerHTML = ''; monthlyEl.classList.remove('warn');
    return;
  }
  remainEl.classList.remove('done');
  remainEl.innerHTML = `Залишилось зібрати: <b>${fmt(left)}</b>`;

  if (target > 0 && goal.deadline) {
    const m = monthsUntil(goal.deadline);
    if (m <= 0) {
      monthlyEl.classList.add('warn');
      monthlyEl.innerHTML = `⏰ До ${fmtDate(goal.deadline)} лишився <b>1 міс. або менше</b> — треба ще ${fmt(left)}`;
    } else {
      monthlyEl.classList.remove('warn');
      monthlyEl.innerHTML = `📅 Відкладати щомісяця: <b>${fmt(left / m)}</b><br>`
        + `<span class="gm-sub">до ${fmtDate(goal.deadline)} • залишилось ${m} міс.</span>`;
    }
  } else {
    monthlyEl.innerHTML = ''; monthlyEl.classList.remove('warn');
  }
}
function addToGoal() {
  const inp = $('#goalInput');
  const v = parseFloat((inp.value || '').replace(',', '.'));
  if (!(v > 0)) { toast('Введіть суму'); return; }
  goal.saved = Math.round(((goal.saved || 0) + v) * 100) / 100;
  saveGoal(); inp.value = ''; inp.blur(); updateGoalCard();
  toast(`Додано ${fmt(v)} до цілі ✓`);
}
function openGoalSheet() {
  sheet(`<h3>🎯 Налаштування цілі</h3>
    <div class="field"><label>Назва цілі</label><input type="text" id="goalNameInp" maxlength="30" value="${esc(goal.name || '')}" placeholder="Напр. Авто"></div>
    <div class="field"><label>Сума цілі, ₴</label><input type="number" inputmode="decimal" id="goalTargetInp" value="${goal.target || ''}" placeholder="30000"></div>
    <div class="field"><label>Вже накопичено, ₴</label><input type="number" inputmode="decimal" id="goalSavedInp" value="${goal.saved || ''}" placeholder="0"></div>
    <div class="field"><label>Зібрати до дати</label><input type="date" id="goalDeadlineInp" value="${goal.deadline || ''}"></div>
    <button class="btn-primary" id="saveGoalBtn">Зберегти ціль</button>
    <button class="btn-secondary btn-danger" id="resetGoalBtn" style="margin-top:10px;">Обнулити накопичення</button>`);
  $('#saveGoalBtn').addEventListener('click', () => {
    goal.name = ($('#goalNameInp').value.trim()) || 'Накопичення';
    goal.target = Math.max(0, parseFloat($('#goalTargetInp').value) || 0);
    goal.saved = Math.max(0, parseFloat($('#goalSavedInp').value) || 0);
    goal.deadline = $('#goalDeadlineInp').value || '';
    saveGoal(); closeSheet(); updateGoalCard(); toast('Ціль збережено');
  });
  $('#resetGoalBtn').addEventListener('click', () => {
    goal.saved = 0; saveGoal(); closeSheet(); updateGoalCard(); toast('Накопичення обнулено');
  });
}

$('#goalAddBtn').addEventListener('click', addToGoal);
$('#goalInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addToGoal(); });
$('#goalEditBtn').addEventListener('click', openGoalSheet);

function renderHome() {
  const now = new Date();
  $('#todayLabel').textContent = `Сьогодні, ${now.getDate()} ${MONTHS_GEN[now.getMonth()]} ${now.getFullYear()}`;
  updateGoalCard();

  const { from, to } = periodRange('month');
  const tx = inRange(transactions, from, to);
  const inc = sum(tx.filter(t => t.type === 'income'));
  const exp = sum(tx.filter(t => t.type === 'expense'));

  $('#balPeriodName').textContent = MONTHS[now.getMonth()].toLowerCase();
  const bal = inc - exp;
  const el = $('#balanceAmount');
  el.textContent = fmt(bal);
  el.className = 'amount ' + (bal >= 0 ? 'glow-green' : '');
  el.style.color = bal >= 0 ? 'var(--income)' : 'var(--expense)';
  $('#balPeriodRange').textContent = `${from.getDate()} – ${to.getDate()} ${MONTHS_GEN[now.getMonth()]}`;
  $('#homeIncome').textContent = fmt(inc);
  $('#homeExpense').textContent = fmt(exp);

  const recent = [...transactions].sort((a,b) => (b.date+b.createdAt).localeCompare(a.date+a.createdAt)).slice(0, 8);
  renderTxList($('#homeTxList'), recent);

  // картка черги чеків
  PhotoDB.countPending().then(c => {
    const wrap = $('#homePendingCard');
    if (!wrap) return;
    if (!c) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = `<div class="card pending-card" data-goto="receipts">
      <span class="pc-ic">🧾</span>
      <div class="pc-txt">
        <div class="pc-title">${c} ${c===1?'чек очікує':'чеків очікують'} розпізнавання</div>
        <div class="pc-sub">Натисни, щоб переглянути та експортувати</div>
      </div>
      <span class="pc-arrow">→</span>
    </div>`;
  });
}

function renderTxList(container, list) {
  if (!list.length) {
    container.innerHTML = `<div class="empty"><span class="big">🪙</span>Поки немає операцій.<br>Натисніть «+» щоб додати.</div>`;
    return;
  }
  container.innerHTML = list.map(t => {
    const c = findCat(t.type, t.category);
    const d = parseYmd(t.date);
    const meta = `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}` + (t.note ? ` • ${esc(t.note)}` : '');
    const src = t.source === 'receipt' ? '<span class="tx-src">чек</span>' : '';
    return `<div class="tx-item" data-tx="${t.id}">
      <div class="tx-icon" style="box-shadow:0 0 12px ${c.color}33;">${c.emoji}</div>
      <div class="tx-mid">
        <div class="tx-cat">${esc(c.name)}${src}</div>
        <div class="tx-meta">${meta}</div>
      </div>
      <div class="tx-amt ${t.type === 'income' ? 'inc' : 'exp'}">${t.type === 'income' ? '+' : '−'}${fmt(t.amount).replace('−','')}</div>
    </div>`;
  }).join('');
  $$('.tx-item', container).forEach(item => {
    item.addEventListener('click', () => openTxSheet(item.dataset.tx));
  });
}

/* ============================================================
   PERIODS
   ============================================================ */
function periodRange(period, ref = new Date()) {
  const r = new Date(ref); r.setHours(0,0,0,0);
  let from, to;
  if (period === 'day') { from = new Date(r); to = new Date(r); }
  else if (period === 'week') {
    const dow = (r.getDay() + 6) % 7; // Пн=0
    from = new Date(r); from.setDate(r.getDate() - dow);
    to = new Date(from); to.setDate(from.getDate() + 6);
  }
  else if (period === 'month') { from = new Date(r.getFullYear(), r.getMonth(), 1); to = new Date(r.getFullYear(), r.getMonth()+1, 0); }
  else if (period === 'year') { from = new Date(r.getFullYear(), 0, 1); to = new Date(r.getFullYear(), 11, 31); }
  else if (period === 'all') { from = new Date(2000,0,1); to = new Date(2100,0,1); }
  else if (period === 'custom') {
    from = state.customFrom ? parseYmd(state.customFrom) : new Date(r.getFullYear(), r.getMonth(), 1);
    to = state.customTo ? parseYmd(state.customTo) : new Date(r);
  }
  to.setHours(23,59,59,999);
  return { from, to };
}
function prevPeriodRange(period) {
  const { from, to } = periodRange(period);
  if (period === 'all' || period === 'custom') {
    const len = to - from;
    return { from: new Date(from - len), to: new Date(from - 1) };
  }
  const ref = new Date(from);
  if (period === 'day') ref.setDate(ref.getDate() - 1);
  else if (period === 'week') ref.setDate(ref.getDate() - 7);
  else if (period === 'month') ref.setMonth(ref.getMonth() - 1);
  else if (period === 'year') ref.setFullYear(ref.getFullYear() - 1);
  return periodRange(period, ref);
}
function inRange(list, from, to) {
  const f = from.getTime(), t = to.getTime();
  return list.filter(x => { const d = parseYmd(x.date).getTime(); return d >= f && d <= t; });
}
const sum = (list) => list.reduce((s, x) => s + x.amount, 0);

/* ============================================================
   ADD
   ============================================================ */
function renderCategories() {
  const grid = $('#catGrid');
  const cats = allCats(state.addType);
  grid.innerHTML = cats.map(c =>
    `<button class="cat-btn ${state.addCat === c.id ? 'active' : ''}" data-cat="${c.id}">
      <span class="emoji">${c.emoji}</span><span>${esc(c.name)}</span>
    </button>`).join('');
  $$('.cat-btn', grid).forEach(b => b.addEventListener('click', () => {
    state.addCat = b.dataset.cat;
    renderCategories(); updateSaveBtn();
  }));
}
function updateAmountDisplay() {
  $('#amountValue').textContent = state.addAmount === '' ? '0' : state.addAmount.replace('.', ',');
  updateSaveBtn();
}
function updateSaveBtn() {
  const amt = parseFloat(state.addAmount.replace(',', '.')) || 0;
  $('#saveTxBtn').disabled = !(amt > 0 && state.addCat);
}
$('#keypad').addEventListener('click', (e) => {
  const k = e.target.closest('.key'); if (!k) return;
  const v = k.dataset.k || k.textContent.trim();
  if (v === 'del') { state.addAmount = state.addAmount.slice(0, -1); }
  else if (v === '.' || v === ',') { if (!state.addAmount.includes('.')) state.addAmount += (state.addAmount === '' ? '0.' : '.'); }
  else {
    if (state.addAmount === '0') state.addAmount = '';
    const dec = state.addAmount.split('.')[1];
    if (dec && dec.length >= 2) return;
    if (state.addAmount.replace('.','').length >= 9) return;
    state.addAmount += v;
  }
  updateAmountDisplay();
});
$('#typeToggle').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.addType = b.dataset.type; state.addCat = null;
  $$('#typeToggle button').forEach(x => x.classList.toggle('active', x === b));
  renderCategories(); updateSaveBtn();
});
/* ---- Photo capture ---- */
$('#photoBtn').addEventListener('click', () => $('#photoInput').click());
$('#photoInput').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    toast('Обробка фото…');
    state.addPhoto = await compressImage(file);
    $('#photoThumb').src = state.addPhoto;
    $('#photoPreview').classList.remove('hidden');
    $('#photoBtn').classList.add('hidden');
  } catch { toast('Не вдалося обробити фото'); }
});
$('#photoRemove').addEventListener('click', () => {
  state.addPhoto = null;
  $('#photoPreview').classList.add('hidden');
  $('#photoBtn').classList.remove('hidden');
  $('#photoThumb').src = '';
});

$('#saveTxBtn').addEventListener('click', async () => {
  const amt = parseFloat(state.addAmount.replace(',', '.')) || 0;
  if (!(amt > 0 && state.addCat)) return;
  const id = 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
  const tx = {
    id, type: state.addType, amount: amt, category: state.addCat,
    date: $('#addDate').value || todayYmd(),
    note: $('#addNote').value.trim(), source: 'manual',
    hasPhoto: !!state.addPhoto,
    createdAt: new Date().toISOString(),
  };
  if (state.addPhoto) { try { await PhotoDB.put(id, state.addPhoto); } catch { tx.hasPhoto = false; } }
  transactions.push(tx);
  saveTx();
  resetAddForm();
  toast('Операцію збережено ✓');
  goto('home');
});
function resetAddForm() {
  state.addAmount = '0'; state.addCat = null; state.addType = 'expense'; state.addPhoto = null;
  $('#addNote').value = ''; $('#addDate').value = todayYmd();
  $('#photoPreview').classList.add('hidden'); $('#photoBtn').classList.remove('hidden'); $('#photoThumb').src = '';
  $$('#typeToggle button').forEach(x => x.classList.toggle('active', x.dataset.type === 'expense'));
  updateAmountDisplay(); renderCategories();
}

/* ============================================================
   CALENDAR
   ============================================================ */
$$('[data-cal]').forEach(b => b.addEventListener('click', () => {
  state.calMonth += parseInt(b.dataset.cal, 10);
  state.calSelectedDay = null;
  renderCalendar();
}));
function renderCalendar() {
  const year = Math.floor(state.calMonth / 12);
  const month = state.calMonth % 12;
  $('#calMonthName').textContent = `${MONTHS[month]} ${year}`;

  $('#calDow').innerHTML = DOW.map(d => `<div class="cal-dow">${d}</div>`).join('');

  const first = new Date(year, month, 1);
  const startPad = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const todayStr = todayYmd();

  // агрегати по днях
  const byDay = {};
  transactions.forEach(t => {
    const d = parseYmd(t.date);
    if (d.getFullYear() === year && d.getMonth() === month) {
      const day = d.getDate();
      byDay[day] = byDay[day] || { inc: 0, exp: 0 };
      byDay[day][t.type === 'income' ? 'inc' : 'exp'] += t.amount;
    }
  });

  let cells = '';
  for (let i = 0; i < startPad; i++) cells += `<div class="cal-day empty-cell"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const ds = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const info = byDay[day];
    const isToday = ds === todayStr;
    const isSel = state.calSelectedDay === ds;
    let markers = '';
    if (info) {
      markers = `<div class="markers">${info.inc ? '<span class="mk inc"></span>' : ''}${info.exp ? '<span class="mk exp"></span>' : ''}</div>`;
    } else markers = '<div class="markers"></div>';
    cells += `<div class="cal-day ${isToday?'today':''} ${isSel?'selected':''}" data-day="${ds}">${day}${markers}</div>`;
  }
  $('#calGrid').innerHTML = cells;

  // підсумок місяця
  const mtx = transactions.filter(t => { const d = parseYmd(t.date); return d.getFullYear()===year && d.getMonth()===month; });
  const mi = sum(mtx.filter(t=>t.type==='income')), me = sum(mtx.filter(t=>t.type==='expense'));
  $('#calSummary').innerHTML = `Доходи ${fmtShort(mi)} • Витрати ${fmtShort(me)}`;

  $$('#calGrid .cal-day[data-day]').forEach(c => c.addEventListener('click', () => {
    state.calSelectedDay = c.dataset.day;
    renderCalendar();
    renderCalDay();
  }));
  renderCalDay();
}
function renderCalDay() {
  const title = $('#calDayTitle');
  if (!state.calSelectedDay) { title.textContent = 'Оберіть день'; $('#calTxList').innerHTML = ''; return; }
  const d = parseYmd(state.calSelectedDay);
  const list = transactions.filter(t => t.date === state.calSelectedDay)
    .sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const inc = sum(list.filter(t=>t.type==='income')), exp = sum(list.filter(t=>t.type==='expense'));
  title.innerHTML = `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} <span style="color:var(--txt-faint);font-weight:400;font-size:13px;">• +${fmtShort(inc)} / −${fmtShort(exp)}</span>`;
  renderTxList($('#calTxList'), list);
}

/* ============================================================
   ANALYTICS
   ============================================================ */
$('#periodBar').addEventListener('click', (e) => {
  const c = e.target.closest('.chip'); if (!c) return;
  state.analyticsPeriod = c.dataset.period;
  $$('#periodBar .chip').forEach(x => x.classList.toggle('active', x === c));
  $('#customRangeCard').classList.toggle('hidden', c.dataset.period !== 'custom');
  renderAnalytics();
});
$('#ioSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.analyticsIO = b.dataset.io;
  $$('#ioSeg button').forEach(x => x.classList.toggle('active', x === b));
  renderAnalytics();
});
['customFrom','customTo'].forEach(id => $('#'+id).addEventListener('change', () => {
  state.customFrom = $('#customFrom').value; state.customTo = $('#customTo').value;
  renderAnalytics();
}));

function renderAnalytics() {
  const { from, to } = periodRange(state.analyticsPeriod);
  if (state.analyticsPeriod === 'custom') {
    const days = Math.max(1, Math.round((to - from) / 86400000) + 1);
    $('#customRangeInfo').textContent = `З ${fmtDate(ymd(from))} по ${fmtDate(ymd(to))} • ${days} дн.`;
  }
  const tx = inRange(transactions, from, to).filter(t => t.type === state.analyticsIO);
  const total = sum(tx);

  $('#donutLabel').textContent = state.analyticsIO === 'income' ? 'Доходи' : 'Витрати';
  $('#donutTotal').textContent = fmtShort(total);

  // group by category
  const groups = {};
  tx.forEach(t => { groups[t.category] = (groups[t.category] || 0) + t.amount; });
  const arr = Object.entries(groups).map(([id, val]) => {
    const c = findCat(state.analyticsIO, id);
    return { ...c, val };
  }).sort((a,b) => b.val - a.val);

  drawDonut($('#donutCanvas'), arr, total);
  renderLegend(arr, total);

  // comparison
  renderCompare(from, to);

  // budgets overview
  renderBudgets();
}

function renderLegend(arr, total) {
  const el = $('#donutLegend');
  if (!arr.length) { el.innerHTML = `<div class="empty" style="padding:10px;">Немає даних за період</div>`; return; }
  el.innerHTML = arr.map(c => {
    const pct = total ? Math.round(c.val/total*100) : 0;
    return `<div class="legend-row">
      <span class="lg-dot" style="background:${c.color};box-shadow:0 0 8px ${c.color}99;"></span>
      <span class="lg-name">${c.emoji} ${esc(c.name)}</span>
      <span class="lg-val">${fmt(c.val)}</span>
      <span class="lg-pct">${pct}%</span>
    </div>`;
  }).join('');
}

function renderCompare(from, to) {
  const prev = prevPeriodRange(state.analyticsPeriod);
  const curTx = inRange(transactions, from, to);
  const prevTx = inRange(transactions, prev.from, prev.to);
  const cur = sum(curTx.filter(t => t.type === state.analyticsIO));
  const pre = sum(prevTx.filter(t => t.type === state.analyticsIO));

  drawBars($('#barCanvas'), [
    { label: 'Попередній', val: pre, color: '#565a82' },
    { label: 'Поточний', val: cur, color: state.analyticsIO === 'income' ? '#3dff9e' : '#ff4d6d' },
  ]);

  let html = '';
  if (pre === 0 && cur === 0) html = `<div class="empty" style="padding:8px;">Немає даних для порівняння</div>`;
  else {
    const diff = cur - pre;
    const pct = pre ? Math.round(diff/pre*100) : 100;
    const up = diff > 0;
    const isExpense = state.analyticsIO === 'expense';
    // для витрат зростання = погано (червоний), для доходів навпаки
    const bad = (isExpense && up) || (!isExpense && !up && diff !== 0);
    const cls = diff === 0 ? '' : (bad ? 'up' : 'down');
    const arrow = diff === 0 ? '→' : (up ? '↑' : '↓');
    html = `<div class="compare-stat ${cls}">${arrow} ${diff>=0?'+':'−'}${fmt(Math.abs(diff)).replace('−','')} (${pre?(diff>=0?'+':'−')+Math.abs(pct)+'%':'новий період'}) vs попередній</div>`;
  }
  $('#compareStats').innerHTML = html;
}

/* ---------- Canvas charts ---------- */
function setupCanvas(canvas, h) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
function drawDonut(canvas, arr, total) {
  const h = 240;
  const { ctx, w } = setupCanvas(canvas, h);
  const cx = w/2, cy = h/2, R = Math.min(w,h)/2 - 14, r = R * 0.62;
  if (!total || !arr.length) {
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI*2); ctx.arc(cx, cy, r, 0, Math.PI*2, true);
    ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fill('evenodd'); return;
  }
  let a0 = -Math.PI/2;
  arr.forEach(c => {
    const frac = c.val/total;
    const a1 = a0 + frac * Math.PI*2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, a0, a1);
    ctx.arc(cx, cy, r, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = c.color;
    ctx.shadowColor = c.color; ctx.shadowBlur = 12;
    ctx.fill();
    ctx.shadowBlur = 0;
    a0 = a1 + 0.02;
  });
}
function drawBars(canvas, data) {
  const h = 200;
  const { ctx, w } = setupCanvas(canvas, h);
  const max = Math.max(...data.map(d => d.val), 1);
  const pad = 40, gap = 40;
  const bw = (w - pad*2 - gap*(data.length-1)) / data.length;
  const baseY = h - 36;
  data.forEach((d, i) => {
    const x = pad + i*(bw+gap);
    const bh = Math.max((d.val/max) * (baseY - 20), d.val > 0 ? 4 : 0);
    const y = baseY - bh;
    // bar
    const grad = ctx.createLinearGradient(0, y, 0, baseY);
    grad.addColorStop(0, d.color); grad.addColorStop(1, d.color + '40');
    ctx.fillStyle = grad;
    ctx.shadowColor = d.color; ctx.shadowBlur = 14;
    roundRect(ctx, x, y, bw, bh, 10); ctx.fill();
    ctx.shadowBlur = 0;
    // value
    ctx.fillStyle = '#eef1ff'; ctx.font = '600 13px -apple-system, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(fmtShort(d.val), x + bw/2, y - 8);
    // label
    ctx.fillStyle = '#8c90b8'; ctx.font = '12px -apple-system, sans-serif';
    ctx.fillText(d.label, x + bw/2, baseY + 20);
  });
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, 0);
  ctx.arcTo(x, y+h, x, y, 0);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
}

/* ============================================================
   QUERY ENGINE (локальний) + БЮДЖЕТИ + Claude API
   ============================================================ */
const CAT_SYN = {
  food:['їжу','їжа','їжі','їжею','еду','еда','еды','продукт','харч','їст','grocer','супермаркет','атб','сільпо','silpo'],
  cafe:['каф','ресторан','кав','кофе','coffee','їдальн','піцер','бар ','фастфуд','mcdonald','макдон'],
  transport:['транспорт','пальн','бензин','палив','таксі','такси','проїзд','метро','автобус','заправ','uber','bolt'],
  home:['житл','оренд','аренд','квартир','rent','іпотек','ипотек'],
  utilities:['комунал','світло','газ','electric','електро','опален','інтернет','internet','вод'],
  health:['здоров','аптек','ліки','медиц','лекарств','лікар','стоматол','врач','клінік'],
  clothes:['одяг','одежд','взутт','обув','шопінг','кросівк'],
  fun:['розваг','развлеч','кіно','кино','ігр','игр','відпочинок','концерт','клуб','боулінг'],
  subs:['підписк','подписк','subscription','netflix','spotify','youtube','apple'],
  edu:['освіт','навчан','образован','курс','книг','школ','репетит'],
  travel:['подорож','путешеств','відпустк','відрядж','готел','квит','авіа','booking'],
  beauty:['крас','салон','перукар','космет','манікюр','барбер','спа','волос','зачіск','стрижк'],
  pets:['тварин','животн','собак','кіт','кот','корм','ветерин'],
  gifts_out:['син ','сину','сина','синов','синочк','дитин','дітям'],
  tech:['техн','гаджет','компют','компʼют','ноутбук','телефон','девайс','навушник'],
  salary:['зарплат','зп','salary','оклад','получк'],
  freelance:['фриланс','freelance','підробіт','подработ'],
  business:['бізнес','бизнес','business','виручк','прибуток від'],
  invest:['інвест','инвест','дивіденд','invest','акці','депозит','відсотк'],
  gifts_in:['подар','gift'],
  sale:['продаж','продав','sale','olx','перепрод'],
  rent_in:['здаю','оренд','аренд','rent'],
};
const PERIOD_NAMES = { day:'сьогодні', week:'цього тижня', month:'цього місяця', prevmonth:'минулого місяця', year:'цього року', all:'за весь час' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function rangeForKey(key) {
  if (key === 'prevmonth') { const d = new Date(); d.setMonth(d.getMonth()-1); return periodRange('month', d); }
  return periodRange(key);
}
function matchCategory(text, type = 'expense') {
  let best = null, bestLen = 0;
  for (const c of allCats(type)) {
    const terms = [c.name.toLowerCase(), ...(CAT_SYN[c.id] || [])];
    for (const t of terms) {
      if (t && t.length >= 3 && text.includes(t) && t.length > bestLen) { best = c; bestLen = t.length; }
    }
  }
  return best;
}

function analyzeQuery(q) {
  const text = ' ' + q.toLowerCase().replace(/[?!.,;]/g, ' ') + ' ';
  let pkey = 'month';
  if (/сьогодн|за сьогодні|today/.test(text)) pkey = 'day';
  else if (/тижд|недел|week/.test(text)) pkey = 'week';
  else if (/минул\w* місяц|прошл\w* месяц|попередн\w* місяц|за минулий/.test(text)) pkey = 'prevmonth';
  else if (/ рік|за год| year|цього року/.test(text)) pkey = 'year';
  else if (/весь час|загалом|взагалі|за весь|all time/.test(text)) pkey = 'all';

  const r = rangeForKey(pkey);
  const periodName = PERIOD_NAMES[pkey];
  const txIn = inRange(transactions, r.from, r.to);

  const isIncome = /дохід|доход|заробив|заработа|надійшл|income|отрима|прибут|выручк/.test(text);
  const isBudget = /ліміт|лимит|перелім|перерасход|перевищ|бюджет|залишок по|остаток по|скільки залиш|сколько остал/.test(text);
  const isTop = /найбільш|больше всего| топ|на що.*найбільш|top|куди.*(пішл|іде|уход)|основн\w* витрат/.test(text);
  const isAverage = /середн|средн|average|на день/.test(text);
  const isCompare = /порівн|сравн|відносно|порівняно|compare|більше чи менше/.test(text);
  const isBalance = /баланс|сальдо|чистий|накопич|скільки.*(всього|на рахунк|в мене)/.test(text);

  // 1. Ліміти
  if (isBudget) {
    const m = periodRange('month');
    const mtx = inRange(transactions, m.from, m.to).filter(t => t.type === 'expense');
    const cat = matchCategory(text, 'expense');
    if (cat) {
      const limit = budgets[cat.id] || 0;
      const spent = sum(mtx.filter(t => t.category === cat.id));
      if (!limit) return { handled: true, answer: `Для статті «${cat.emoji} ${cat.name}» ліміт не встановлено.\nВитрачено цього місяця: ${fmt(spent)}.\nВстановити ліміт: Налаштування → Ліміти по статтях.` };
      const left = limit - spent;
      return { handled: true, answer: left >= 0
        ? `${cat.emoji} ${cat.name}: витрачено ${fmt(spent)} з ${fmt(limit)}.\n✅ Залишок ліміту: ${fmt(left)} (використано ${Math.round(spent/limit*100)}%).`
        : `${cat.emoji} ${cat.name}: ⚠️ ліміт перевищено!\nВитрачено ${fmt(spent)} з ${fmt(limit)} — перевитрата ${fmt(-left)}.` };
    }
    const ids = Object.keys(budgets).filter(id => budgets[id] > 0);
    if (!ids.length) return { handled: true, answer: 'Ліміти ще не встановлені.\nДодай їх у Налаштування → Ліміти по статтях.' };
    const lines = ids.map(id => {
      const c = findCat('expense', id), limit = budgets[id], spent = sum(mtx.filter(t => t.category === id)), left = limit - spent;
      return left >= 0 ? `${c.emoji} ${c.name}: ${fmt(spent)} / ${fmt(limit)} — залишок ${fmt(left)}`
                       : `${c.emoji} ${c.name}: ⚠️ ${fmt(spent)} / ${fmt(limit)} — перевитрата ${fmt(-left)}`;
    });
    return { handled: true, answer: 'Ліміти цього місяця:\n' + lines.join('\n') };
  }

  // 2. Порівняння
  if (isCompare) {
    const cat = matchCategory(text, 'expense');
    const m = periodRange('month');
    const d = new Date(); d.setMonth(d.getMonth()-1); const pm = periodRange('month', d);
    const cur = sum(inRange(transactions, m.from, m.to).filter(t => t.type === 'expense' && (!cat || t.category === cat.id)));
    const pre = sum(inRange(transactions, pm.from, pm.to).filter(t => t.type === 'expense' && (!cat || t.category === cat.id)));
    const diff = cur - pre;
    const label = cat ? `«${cat.emoji} ${cat.name}»` : 'витрати';
    const change = diff === 0 ? 'без змін' : (diff > 0 ? 'більше на ' : 'менше на ') + fmt(Math.abs(diff)) + (pre ? ` (${Math.round(Math.abs(diff)/pre*100)}%)` : '');
    return { handled: true, answer: `${cap(label)}: цього місяця ${fmt(cur)}, минулого ${fmt(pre)}.\nЦе ${change}.` };
  }

  // 3. Топ витрат
  if (isTop) {
    const exp = txIn.filter(t => t.type === 'expense');
    const groups = {}; exp.forEach(t => groups[t.category] = (groups[t.category] || 0) + t.amount);
    const arr = Object.entries(groups).map(([id, v]) => ({ c: findCat('expense', id), v })).sort((a, b) => b.v - a.v).slice(0, 5);
    if (!arr.length) return { handled: true, answer: `Витрат ${periodName} не знайдено.` };
    return { handled: true, answer: `Найбільші витрати ${periodName}:\n` + arr.map((x, i) => `${i+1}. ${x.c.emoji} ${x.c.name} — ${fmt(x.v)}`).join('\n') };
  }

  // 4. Середнє
  if (isAverage) {
    const cat = matchCategory(text, 'expense');
    const exp = txIn.filter(t => t.type === 'expense' && (!cat || t.category === cat.id));
    const total = sum(exp);
    const days = Math.max(1, Math.round((r.to - r.from) / 86400000) + 1);
    return { handled: true, answer: (cat ? `«${cat.emoji} ${cat.name}» — ` : 'Витрати ') + `${periodName}: усього ${fmt(total)}, у середньому ${fmt(total/days)}/день.` };
  }

  // 5. Дохід
  if (isIncome) {
    const cat = matchCategory(text, 'income');
    const list = txIn.filter(t => t.type === 'income' && (!cat || t.category === cat.id));
    const total = sum(list);
    return { handled: true, answer: cat ? `Дохід за статтею «${cat.emoji} ${cat.name}» ${periodName}: ${fmt(total)}.` : `Загальний дохід ${periodName}: ${fmt(total)}.` };
  }

  // 6. Баланс
  if (isBalance) {
    const inc = sum(txIn.filter(t => t.type === 'income')), exp = sum(txIn.filter(t => t.type === 'expense'));
    return { handled: true, answer: `Баланс ${periodName}: ${fmt(inc - exp)}.\nДоходи: ${fmt(inc)} • витрати: ${fmt(exp)}.` };
  }

  // 7. Витрати (за замовчуванням)
  const cat = matchCategory(text, 'expense');
  const isSpend = /витрат|потрат|спустив|spent|израсход|скільки.*(на | за )/.test(text) || cat;
  if (isSpend) {
    const list = txIn.filter(t => t.type === 'expense' && (!cat || t.category === cat.id));
    const total = sum(list);
    return { handled: true, answer: cat
      ? `Витрати за статтею «${cat.emoji} ${cat.name}» ${periodName}: ${fmt(total)} (${list.length} оп.).`
      : `Загальні витрати ${periodName}: ${fmt(total)}.` };
  }

  return { handled: false, answer: null };
}

/* ---- Query UI ---- */
async function runQuery(q) {
  q = (q || '').trim(); if (!q) return;
  $('#queryInput').value = q;
  const ans = analyzeQuery(q);
  if (ans.handled) { showAnswer(ans.answer, 'local'); return; }
  if (aiConfig.enabled && aiConfig.key) {
    showAnswer('Аналізую ваші дані…', 'loading');
    try { showAnswer(await callClaude(q), 'ai'); }
    catch (e) { showAnswer('Помилка ШІ-помічника: ' + e.message, 'err'); }
  } else {
    showAnswer('Не вдалося розпізнати запит локально. Спробуй переформулювати (напр. «скільки витратив на кафе цього місяця») або підключи ШІ-помічника в Налаштування → ШІ-помічник для будь-яких запитань.', 'err');
  }
}
function showAnswer(text, type) {
  const el = $('#queryAnswer'); el.classList.remove('hidden');
  const badges = {
    local: '<span class="qa-badge local">ЛОКАЛЬНО</span>',
    ai: '<span class="qa-badge ai">CLAUDE ШІ</span>',
    loading: '<span class="qa-badge ai">CLAUDE ШІ</span>',
    err: '<span class="qa-badge err">УВАГА</span>',
  };
  el.innerHTML = (badges[type] || '') + (type === 'loading' ? `<div class="qa-loader">⏳ ${esc(text)}</div>` : esc(text));
}
$('#queryBtn').addEventListener('click', () => runQuery($('#queryInput').value));
$('#queryInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runQuery($('#queryInput').value); });
$('#querySuggest').addEventListener('click', (e) => { const b = e.target.closest('.qchip'); if (b) runQuery(b.textContent); });
$('#budgetsJump').addEventListener('click', openBudgetsSheet);

/* ---- Claude API ---- */
function buildFinanceContext() {
  const catName = {};
  ['expense','income'].forEach(tp => allCats(tp).forEach(c => catName[c.id] = c.name));
  return {
    today: todayYmd(), currency: 'UAH (₴)',
    budgets_monthly: budgets,
    transactions: transactions.map(t => ({
      date: t.date, type: t.type === 'income' ? 'дохід' : 'витрата',
      category: findCat(t.type, t.category).name, amount: t.amount, note: t.note || undefined,
    })),
  };
}
async function callClaude(q) {
  if (!aiConfig.key) throw new Error('немає API-ключа');
  const system = `Ти — фінансовий помічник у застосунку «Гроші». Сьогодні ${todayYmd()}. `
    + `Відповідай українською, стисло й конкретно, з числами у гривнях (₴). `
    + `Використовуй ВИКЛЮЧНО надані дані операцій. Якщо даних бракує — так і скажи, не вигадуй. `
    + `Дай одразу готову відповідь без розмірковувань уголос.`;
  const userContent = `Дані користувача (JSON):\n${JSON.stringify(buildFinanceContext())}\n\nЗапитання: ${q}`;
  const body = JSON.stringify({
    model: aiConfig.model || 'claude-opus-4-8',
    max_tokens: 1024,
    thinking: { type: 'disabled' },
    system,
    messages: [{ role: 'user', content: userContent }],
  });
  const headers = {
    'content-type': 'application/json',
    'x-api-key': aiConfig.key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const retryable = new Set([429, 500, 502, 503, 529]);
  let lastErr = 'не вдалося звʼязатися';
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 800 * (2 ** (attempt - 1)))); // 0.8 / 1.6 / 3.2 с
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body });
    } catch { lastErr = 'немає зʼєднання з мережею'; continue; }
    if (res.ok) {
      const j = await res.json();
      const txt = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      return txt || '(порожня відповідь)';
    }
    let detail = '';
    try { const j = await res.json(); detail = (j.error && j.error.message) || ''; } catch {}
    if (res.status === 401) throw new Error('невірний API-ключ');
    if (res.status === 400) throw new Error('некоректний запит: ' + detail.slice(0, 80));
    if (res.status === 402 || /credit|balance|insufficient/i.test(detail)) throw new Error('недостатньо коштів на балансі Anthropic');
    if (!retryable.has(res.status)) throw new Error(detail.slice(0, 80) || ('помилка ' + res.status));
    lastErr = (res.status === 529 || /overload/i.test(detail)) ? 'сервери Claude перевантажені' : ('тимчасова помилка ' + res.status);
  }
  throw new Error(lastErr + ' — спробуй ще раз за хвилину');
}

/* ---- Budgets ---- */
function openBudgetsSheet() {
  const cats = allCats('expense');
  sheet(`<h3>Ліміти по статтях (місяць)</h3>
    <p style="color:var(--txt-dim);font-size:13px;margin-top:-8px;">Скільки максимум готовий витрачати щомісяця. Залиш порожнім — без ліміту.</p>
    <div id="budgetInputs" style="max-height:48vh;overflow:auto;">${cats.map(c =>
      `<div class="budget-input-row"><span class="bi-emoji">${c.emoji}</span><span class="bi-name">${esc(c.name)}</span>
       <input type="number" inputmode="decimal" data-bid="${c.id}" value="${budgets[c.id] || ''}" placeholder="0 ₴"></div>`).join('')}</div>
    <button class="btn-primary" id="saveBudgetsBtn" style="margin-top:16px;">Зберегти ліміти</button>`);
  $('#saveBudgetsBtn').addEventListener('click', () => {
    const nb = {};
    $$('#budgetInputs input').forEach(i => { const v = parseFloat(i.value); if (v > 0) nb[i.dataset.bid] = v; });
    budgets = nb; saveBudgets(); closeSheet(); toast('Ліміти збережено');
    renderStats(); if ($('.screen.active').id === 'screen-analytics') renderBudgets();
  });
}
function renderBudgets() {
  const card = $('#budgetsCard');
  const ids = Object.keys(budgets).filter(id => budgets[id] > 0);
  if (!ids.length) { card.innerHTML = `<div class="empty" style="padding:12px;">Ліміти не встановлені.<br>Натисни «Налаштувати», щоб задати місячні бюджети.</div>`; return; }
  const m = periodRange('month');
  const mtx = inRange(transactions, m.from, m.to).filter(t => t.type === 'expense');
  card.innerHTML = ids.map(id => {
    const c = findCat('expense', id), limit = budgets[id], spent = sum(mtx.filter(t => t.category === id));
    const over = spent > limit, ratio = spent / limit, pct = Math.round(ratio * 100);
    const color = over ? 'var(--neon-red)' : ratio > 0.8 ? 'var(--neon-amber)' : 'var(--neon-green)';
    return `<div class="budget-row">
      <div class="budget-top"><span class="b-name">${c.emoji} ${esc(c.name)}</span>
        <span class="b-val ${over?'budget-over':''}"><b>${fmt(spent)}</b> / ${fmt(limit)}</span></div>
      <div class="budget-bar"><span style="width:${Math.min(100, ratio*100)}%;background:${color};box-shadow:0 0 8px ${color};"></span></div>
      <div style="font-size:11px;color:var(--txt-faint);margin-top:4px;">${over ? '⚠️ перевитрата ' + fmt(spent-limit) : 'залишок ' + fmt(limit-spent) + ` • ${pct}%`}</div>
    </div>`;
  }).join('');
}

/* ---- AI settings ---- */
function openAiSheet() {
  sheet(`<h3>🤖 ШІ-помічник (Claude)</h3>
    <p style="color:var(--txt-dim);font-size:13px;line-height:1.55;">Відповідає на будь-які запити в Аналітиці, які не розпізнав локальний движок. Потрібен власний API-ключ Anthropic (console.anthropic.com → API Keys). Ключ зберігається ЛИШЕ на цьому пристрої й надсилається напряму до Anthropic.</p>
    <div class="field"><label>API-ключ Anthropic</label><input type="password" id="aiKey" placeholder="sk-ant-..." value="${esc(aiConfig.key || '')}"></div>
    <div class="field"><label>Модель</label>
      <select id="aiModel">
        <option value="claude-opus-4-8">Opus 4.8 — найрозумніша</option>
        <option value="claude-sonnet-4-6">Sonnet 4.6 — баланс</option>
        <option value="claude-haiku-4-5">Haiku 4.5 — швидша й дешевша</option>
      </select></div>
    <div class="set-row"><div class="sr-left"><span class="sr-ic">⚡</span><div>Увімкнути ШІ-помічника</div></div>
      <input type="checkbox" id="aiEnabled" ${aiConfig.enabled ? 'checked' : ''} style="width:24px;height:24px;accent-color:#9b5cff;"></div>
    <button class="btn-primary" id="saveAiBtn" style="margin-top:16px;">Зберегти</button>
    <button class="btn-secondary" id="testAiBtn" style="margin-top:10px;">Перевірити підключення</button>`);
  $('#aiModel').value = aiConfig.model || 'claude-opus-4-8';
  $('#saveAiBtn').addEventListener('click', () => {
    aiConfig.key = $('#aiKey').value.trim();
    aiConfig.model = $('#aiModel').value;
    aiConfig.enabled = $('#aiEnabled').checked;
    saveAi(); closeSheet(); toast('Налаштування ШІ збережено'); renderStats();
  });
  $('#testAiBtn').addEventListener('click', async () => {
    const k = $('#aiKey').value.trim(); if (!k) { toast('Спершу введіть ключ'); return; }
    const prev = { ...aiConfig };
    aiConfig.key = k; aiConfig.model = $('#aiModel').value;
    toast('Перевірка підключення…');
    try { await callClaude('Відповідай одним словом: працює?'); toast('✅ Підключення працює'); }
    catch (e) { toast('❌ ' + e.message.slice(0, 50)); }
    aiConfig = prev;
  });
}

/* ============================================================
   TRANSACTION SHEET (view / delete)
   ============================================================ */
function openTxSheet(id) {
  const t = transactions.find(x => x.id === id); if (!t) return;
  const c = findCat(t.type, t.category);
  const d = parseYmd(t.date);
  sheet(`
    <h3>${c.emoji} ${esc(c.name)}</h3>
    <div style="text-align:center;font-size:38px;font-weight:800;color:${t.type==='income'?'var(--income)':'var(--expense)'};margin:6px 0;">
      ${t.type==='income'?'+':'−'}${fmt(t.amount).replace('−','')}
    </div>
    <div id="txPhotoWrap"></div>
    <div class="set-row"><span>Тип</span><span>${t.type==='income'?'Дохід':'Витрата'}</span></div>
    <div class="set-row"><span>Дата</span><span>${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}</span></div>
    ${t.note?`<div class="set-row"><span>Нотатка</span><span>${esc(t.note)}</span></div>`:''}
    <div class="set-row"><span>Джерело</span><span>${t.source==='receipt'?'Чек 🧾':'Вручну'}</span></div>
    <button class="btn-secondary btn-danger" style="margin-top:16px;" id="delTxBtn">🗑️ Видалити операцію</button>
  `);
  if (t.hasPhoto) {
    PhotoDB.get(id).then(url => {
      if (!url) return;
      const wrap = $('#txPhotoWrap'); if (!wrap) return;
      wrap.innerHTML = `<img class="tx-photo-thumb" src="${url}" alt="чек">`;
      $('.tx-photo-thumb', wrap).addEventListener('click', () => openPhotoViewer(url));
    });
  }
  $('#delTxBtn').addEventListener('click', async () => {
    transactions = transactions.filter(x => x.id !== id);
    saveTx(); if (t.hasPhoto) await PhotoDB.del(id);
    closeSheet(); toast('Видалено'); refreshAll();
  });
}

/* ============================================================
   RECEIPTS — черга на розпізнавання
   ============================================================ */
$('#rcpCaptureBtn').addEventListener('click', () => $('#rcpInput').click());
$('#rcpInput').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    toast('Обробка фото…');
    const photo = await compressImage(file);
    const id = 'rcp_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
    await PhotoDB.putPending(id, { date: todayYmd(), photo, createdAt: new Date().toISOString() });
    renderReceipts(); renderHome();
    toast('Чек додано в чергу ✓');
  } catch { toast('Не вдалося обробити фото'); }
});
$('#rcpExportBtn').addEventListener('click', exportReceiptsForRecognition);

async function renderReceipts() {
  const items = (await PhotoDB.allPending()).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  $('#rcpCountTitle').textContent = items.length ? `У черзі: ${items.length}` : 'Черга порожня';
  const grid = $('#rcpGrid');
  if (!items.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1;"><span class="big">🧾</span>Поки немає чеків.<br>Сфотографуй чек кнопкою вгорі.</div>`;
    return;
  }
  grid.innerHTML = items.map(it => {
    const d = parseYmd(it.date);
    return `<div class="rcp-item" data-rcp="${it.id}">
      <img src="${it.photo}" alt="чек">
      <span class="rcp-date">${d.getDate()} ${MONTHS_GEN[d.getMonth()]}</span>
      <button class="rcp-del" data-del="${it.id}">✕</button>
    </div>`;
  }).join('');
  $$('.rcp-item', grid).forEach(el => el.addEventListener('click', (ev) => {
    if (ev.target.closest('.rcp-del')) return;
    const it = items.find(x => x.id === el.dataset.rcp);
    if (it) openPhotoViewer(it.photo);
  }));
  $$('.rcp-del', grid).forEach(b => b.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    await PhotoDB.delPending(b.dataset.del);
    renderReceipts(); renderHome();
    toast('Видалено з черги');
  }));
}

async function exportReceiptsForRecognition() {
  const items = await PhotoDB.allPending();
  if (!items.length) { toast('Немає чеків для розпізнавання'); return; }
  const data = {
    app: 'groshi', kind: 'recognition_request', version: 1,
    createdAt: new Date().toISOString(),
    receipts: items.map(it => ({ id: it.id, date: it.date, photo: it.photo })),
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `groshi-розпізнати-${todayYmd()}.json`;
  a.click(); URL.revokeObjectURL(url);
  toast(`Експортовано ${items.length} чеків — надішли файл Claude`);
}

/* ============================================================
   SETTINGS
   ============================================================ */
$$('[data-set]').forEach(r => r.addEventListener('click', () => {
  const action = r.dataset.set;
  if (action === 'changePin') PIN.show('change-old');
  else if (action === 'export') exportData();
  else if (action === 'import') $('#importFile').click();
  else if (action === 'receipts') goto('receipts');
  else if (action === 'budgets') openBudgetsSheet();
  else if (action === 'ai') openAiSheet();
  else if (action === 'categories') openCategorySheet();
  else if (action === 'clear') confirmClear();
}));

function renderStats() {
  const n = transactions.length;
  const inc = sum(transactions.filter(t=>t.type==='income'));
  const exp = sum(transactions.filter(t=>t.type==='expense'));
  $('#statLine').textContent = `Операцій: ${n} • Всього доходів: ${fmtShort(inc)} • витрат: ${fmtShort(exp)}`;
  PhotoDB.countPending().then(c => {
    $('#rcpSetCount').textContent = c ? `${c} у черзі на розпізнавання` : 'Фото чеків у черзі';
  });
  const bc = Object.keys(budgets).filter(id => budgets[id] > 0).length;
  $('#budgetSetCount').textContent = bc ? `${bc} статей з лімітом` : 'Місячні бюджети витрат';
  $('#aiSetStatus').textContent = (aiConfig.enabled && aiConfig.key)
    ? `Увімкнено • ${(aiConfig.model || '').replace('claude-','')}` : 'Вимкнено — для складних запитів';
}

async function exportData() {
  toast('Готую копію…');
  let photos = {};
  try { photos = await PhotoDB.all(); } catch {}
  const data = { app: 'groshi', version: 1, exportedAt: new Date().toISOString(), transactions, customCats, budgets, goal, photos };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `groshi-backup-${todayYmd()}.json`;
  a.click(); URL.revokeObjectURL(url);
  toast('Резервну копію збережено');
}

$('#importFile').addEventListener('change', (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try { importData(JSON.parse(reader.result)); }
    catch { toast('Помилка читання файлу'); }
    e.target.value = '';
  };
  reader.readAsText(file);
});

// Універсальний імпорт: резервна копія АБО результат розпізнавання чеків (з receiptId)
function importData(data) {
  const incoming = Array.isArray(data) ? data : (data.transactions || []);
  if (!Array.isArray(incoming)) { toast('Невідомий формат файлу'); return; }
  let added = 0;
  const existing = new Set(transactions.map(t => t.id));
  const created = [];
  incoming.forEach(t => {
    const tx = normalizeTx(t);
    if (!tx || existing.has(tx.id)) return;
    if (t.receiptId) tx.__receiptId = t.receiptId;
    transactions.push(tx); existing.add(tx.id); added++; created.push(tx);
  });
  if (data.customCats) {
    ['expense','income'].forEach(k => {
      (data.customCats[k]||[]).forEach(c => {
        if (!allCats(k).find(x => x.id === c.id)) customCats[k].push(c);
      });
    });
    saveCats();
  }
  if (data.budgets && typeof data.budgets === 'object') { budgets = { ...budgets, ...data.budgets }; saveBudgets(); }
  if (data.goal && typeof data.goal === 'object') { goal = { ...goal, ...data.goal }; saveGoal(); }

  // асинхронно: прикріпити фото з черги розпізнавання + відновити фото з бекапу
  (async () => {
    let recognized = 0;
    for (const tx of created) {
      if (tx.__receiptId) {
        const p = await PhotoDB.getPending(tx.__receiptId);
        if (p && p.photo) { await PhotoDB.put(tx.id, p.photo); tx.hasPhoto = true; await PhotoDB.delPending(tx.__receiptId); recognized++; }
        delete tx.__receiptId;
      }
    }
    if (data.photos && typeof data.photos === 'object') {
      for (const [k, v] of Object.entries(data.photos)) { try { await PhotoDB.put(k, v); } catch {} }
    }
    saveTx(); refreshAll();
    toast(recognized ? `Розпізнано чеків: ${recognized}` : `Імпортовано: ${added} операцій`);
  })();
}

function normalizeTx(t) {
  if (!t || typeof t.amount === 'undefined') return null;
  const type = t.type === 'income' ? 'income' : 'expense';
  return {
    id: t.id || ('tx_' + Date.now() + '_' + Math.random().toString(36).slice(2,7)),
    type,
    amount: Math.abs(parseFloat(t.amount)) || 0,
    category: t.category || (type === 'income' ? 'other_inc' : 'other_exp'),
    date: t.date || todayYmd(),
    note: t.note || '',
    source: t.source || 'receipt',
    hasPhoto: !!t.hasPhoto,
    createdAt: t.createdAt || new Date().toISOString(),
  };
}

function openCategorySheet() {
  sheet(`
    <h3>Власна стаття</h3>
    <div class="seg" id="newCatType" style="margin-bottom:14px;">
      <button data-t="expense" class="active">Витрата</button>
      <button data-t="income">Дохід</button>
    </div>
    <div class="field"><label>Назва</label><input type="text" id="newCatName" placeholder="Напр. Спорт" maxlength="20"></div>
    <div class="field"><label>Емодзі</label><input type="text" id="newCatEmoji" placeholder="🏋️" maxlength="4"></div>
    <button class="btn-primary" id="addCatBtn">Додати статтю</button>
  `);
  let nt = 'expense';
  $$('#newCatType button').forEach(b => b.addEventListener('click', () => {
    nt = b.dataset.t; $$('#newCatType button').forEach(x => x.classList.toggle('active', x===b));
  }));
  $('#addCatBtn').addEventListener('click', () => {
    const name = $('#newCatName').value.trim();
    const emoji = $('#newCatEmoji').value.trim() || '🎯';
    if (!name) { toast('Введіть назву'); return; }
    const palette = ['#00f0ff','#ff2bd6','#3dff9e','#9b5cff','#ffb13d','#5c8bff','#ff7b3d'];
    customCats[nt].push({
      id: 'c_' + Date.now().toString(36),
      name, emoji, color: palette[Math.floor(Math.random()*palette.length)]
    });
    saveCats(); closeSheet(); toast('Статтю додано'); renderCategories();
  });
}

function confirmClear() {
  sheet(`
    <h3>Очистити всі дані?</h3>
    <p style="color:var(--txt-dim);font-size:14px;">Усі операції та власні статті буде видалено без відновлення. PIN-код залишиться. Рекомендуємо спершу зробити експорт.</p>
    <button class="btn-secondary btn-danger" id="confirmClearBtn" style="margin-top:10px;">Так, видалити все</button>
    <button class="btn-secondary" id="cancelClearBtn" style="margin-top:10px;">Скасувати</button>
  `);
  $('#confirmClearBtn').addEventListener('click', () => {
    transactions = []; customCats = { expense: [], income: [] };
    saveTx(); saveCats(); closeSheet(); refreshAll(); toast('Дані очищено');
  });
  $('#cancelClearBtn').addEventListener('click', closeSheet);
}

/* ============================================================
   SHEET helpers
   ============================================================ */
function sheet(html) {
  $('#sheetContent').innerHTML = html;
  $('#sheetBackdrop').classList.add('show');
}
function closeSheet() { $('#sheetBackdrop').classList.remove('show'); }
$('#sheetBackdrop').addEventListener('click', (e) => { if (e.target.id === 'sheetBackdrop') closeSheet(); });

/* Photo viewer */
function openPhotoViewer(url) {
  $('#photoViewerImg').src = url;
  $('#photoViewer').classList.add('show');
}
$('#photoViewer').addEventListener('click', () => {
  $('#photoViewer').classList.remove('show');
  $('#photoViewerImg').src = '';
});

/* ============================================================
   TOAST
   ============================================================ */
let toastTimer;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ============================================================
   UTIL
   ============================================================ */
function esc(s) { return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

function refreshAll() {
  const active = $('.screen.active').id.replace('screen-', '');
  renderHome();
  if (active === 'calendar') renderCalendar();
  if (active === 'analytics') renderAnalytics();
  if (active === 'settings') renderStats();
}

/* ============================================================
   INIT
   ============================================================ */
function init() {
  load();
  showWisdom();
  $('#addDate').value = todayYmd();
  $('#customFrom').value = ymd(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  $('#customTo').value = todayYmd();
  resetAddForm();
  renderHome();
  PIN.init();
}
init();

/* Service worker */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(()=>{}));
}
