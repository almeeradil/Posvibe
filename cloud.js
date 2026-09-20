/* ============================================================
   Posvibe — Lovable Cloud persistence, login logging & audit trail
   Replaces browser-only storage with the cloud database.
   ============================================================ */
(function () {
  var REST = 'https://rcteqxevbpeyvlwmptgg.supabase.co/rest/v1';
  var KEY = 'sb_publishable_SMqFeCWCuItkGsSBu_zQtA_EW9nkQto';
  var EMPTY_UUID = '00000000-0000-0000-0000-000000000000';

  /* userData collection  ->  cloud table */
  var COLL = {
    orders: 'sale_invoices',
    purchaseinvoices: 'purchase_invoices',
    quotations: 'quotations',
    patients: 'patients',
    debitnotes: 'debit_notes',
    inventory: 'products',
    customers: 'customers',
    suppliers: 'suppliers',
    purchases: 'purchases',
    payouts: 'payouts',
    expenses: 'expenses',
    otherincome: 'other_income',
    cashbank: 'cash_bank',
    salaries: 'salaries',
    attendance: 'attendance',
    scans: 'scans',
    activities: 'activities'
  };
  var SETTING_KEYS = ['settings', 'counters', 'grow'];

  var LABELS = {
    orders: 'Invoices & sales', purchaseinvoices: 'Purchase invoices', quotations: 'Quotations',
    patients: 'Patient records', debitnotes: 'Debit notes', inventory: 'Inventory items',
    customers: 'Customers', suppliers: 'Suppliers', purchases: 'Purchase orders',
    payouts: 'Payments out', expenses: 'Expenses', otherincome: 'Other income',
    cashbank: 'Cash & bank', salaries: 'Salaries', attendance: 'Attendance',
    scans: 'Barcode scans', activities: 'Activity entries'
  };

  var state = {
    ready: false,
    online: false,
    lastSync: null,
    lastError: null,
    pending: false,
    syncing: false,
    user: { email: '', role: '' },
    sessionRef: null,
    sessionRowId: null
  };

  /* ---------- low level REST ---------- */
  function headers(extra) {
    var h = { apikey: KEY, 'Content-Type': 'application/json' };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  async function req(method, path, body, extra) {
    var res = await fetch(REST + path, {
      method: method,
      headers: headers(extra),
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      var txt = await res.text();
      throw new Error(method + ' ' + path + ' [' + res.status + '] ' + txt);
    }
    if (res.status === 204) return null;
    var text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  function get(path) { return req('GET', path); }
  function upsert(table, rows) {
    if (!rows.length) return Promise.resolve();
    return req('POST', '/' + table, rows, {
      Prefer: 'resolution=merge-duplicates,return=minimal'
    });
  }

  async function sha256(text) {
    try {
      var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
      return Array.from(new Uint8Array(buf)).map(function (b) {
        return b.toString(16).padStart(2, '0');
      }).join('');
    } catch (e) {
      return 'plain:' + String(text);
    }
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /* ---------- overlay ---------- */
  function overlay(show, msg) {
    var el = document.getElementById('pvCloudOverlay');
    if (show) {
      if (!el) {
        el = document.createElement('div');
        el.id = 'pvCloudOverlay';
        el.className = 'fixed inset-0 z-[100] bg-slate-900/95 flex items-center justify-center';
        el.innerHTML =
          '<div class="text-center text-white"><div class="text-lg font-extrabold">Posvibe</div>' +
          '<div id="pvCloudOverlayMsg" class="text-xs text-slate-300 mt-2">Connecting to your cloud database…</div></div>';
        document.body.appendChild(el);
      }
      if (msg) document.getElementById('pvCloudOverlayMsg').innerText = msg;
    } else if (el) {
      el.remove();
    }
  }

  /* ---------- accounts ---------- */
  function localAccounts() {
    try { return JSON.parse(localStorage.getItem('posvibeAccounts')) || {}; } catch (e) { return {}; }
  }

  async function pullAccounts() {
    var rows = await get('/app_accounts?select=role_key,email,password_hash,is_verified,display_name');
    var acc = {};
    (rows || []).forEach(function (r) {
      acc[r.role_key] = {
        email: r.email,
        hash: r.password_hash,
        verified: r.is_verified !== false,
        name: r.display_name || ''
      };
    });
    localStorage.setItem('posvibeAccounts', JSON.stringify(acc));
    return acc;
  }

  async function saveAccount(kind, email, password) {
    var hash = await sha256(password);
    await upsert('app_accounts', [{ role_key: kind, email: email, password_hash: hash }]);
    var acc = localAccounts();
    acc[kind] = { email: email, hash: hash };
    localStorage.setItem('posvibeAccounts', JSON.stringify(acc));
    audit('Account saved', 'Account', kind, { email: email });
  }

  /* ---------- pull / push app data ---------- */
  async function pullData() {
    var fresh = {};
    var names = Object.keys(COLL);
    var results = await Promise.all(names.map(function (n) {
      return get('/' + COLL[n] + '?select=id,record,created_by,updated_by,created_at&order=created_at.desc');
    }));
    names.forEach(function (n, i) {
      fresh[n] = (results[i] || []).map(function (row) {
        var rec = row.record || {};
        rec._cid = row.id;
        rec._by = row.created_by || rec._by || '';
        rec._updatedBy = row.updated_by || '';
        return rec;
      });
    });
    var settingRows = await get('/app_settings?select=key,value');
    (settingRows || []).forEach(function (r) {
      if (SETTING_KEYS.indexOf(r.key) !== -1) fresh[r.key] = r.value;
    });
    return fresh;
  }

  async function pushData() {
    var actor = state.user.email || 'system';
    for (var name in COLL) {
      var table = COLL[name];
      var list = Array.isArray(userData[name]) ? userData[name] : [];
      var rows = list.map(function (item) {
        if (!item._cid) item._cid = uuid();
        if (!item._by) item._by = actor;
        return {
          id: item._cid,
          record: item,
          created_by: item._by,
          updated_by: actor
        };
      });
      for (var i = 0; i < rows.length; i += 200) {
        await upsert(table, rows.slice(i, i + 200));
      }
      var ids = rows.map(function (r) { return r.id; });
      if (ids.length) {
        await req('DELETE', '/' + table + '?id=not.in.(' + ids.join(',') + ')');
      } else {
        await req('DELETE', '/' + table + '?id=neq.' + EMPTY_UUID);
      }
    }
    var settingRows = SETTING_KEYS.filter(function (k) { return userData[k]; }).map(function (k) {
      return { key: k, value: userData[k], updated_by: actor };
    });
    if (settingRows.length) await upsert('app_settings', settingRows);
  }

  var syncTimer = null;
  function queueSync() {
    state.pending = true;
    renderBackupTab();
    clearTimeout(syncTimer);
    syncTimer = setTimeout(runSync, 600);
  }

  async function runSync() {
    if (state.syncing) { queueSync(); return; }
    state.syncing = true;
    renderBackupTab();
    try {
      await pushData();
      state.pending = false;
      state.online = true;
      state.lastError = null;
      state.lastSync = new Date();
      localStorage.setItem('pvLastCloudSync', state.lastSync.toISOString());
    } catch (e) {
      state.online = false;
      state.lastError = e.message;
      console.error('Cloud sync failed', e);
    }
    state.syncing = false;
    renderBackupTab();
  }

  /* ---------- login history & audit ---------- */
  async function logLogin(email, role) {
    state.user = { email: email, role: role, verified: state.user ? state.user.verified !== false : true };
    state.sessionRef = uuid();
    try {
      var rows = await req('POST', '/login_sessions', [{
        email: email,
        role: role,
        session_ref: state.sessionRef,
        user_agent: navigator.userAgent,
        platform: navigator.platform || '',
        ip_address: await lookupIp()
      }], { Prefer: 'return=representation' });
      if (rows && rows[0]) state.sessionRowId = rows[0].id;
      state.online = true;
    } catch (e) {
      state.lastError = e.message;
    }
    audit('Signed in', 'Session', role, { email: email });
  }

  async function lookupIp() {
    try {
      var r = await fetch('https://api.ipify.org?format=json');
      var j = await r.json();
      return j.ip || '';
    } catch (e) { return ''; }
  }

  async function logLogout() {
    if (!state.sessionRowId) return;
    audit('Signed out', 'Session', state.user.role, { email: state.user.email });
    try {
      await req('PATCH', '/login_sessions?id=eq.' + state.sessionRowId, { logged_out_at: new Date().toISOString() });
    } catch (e) { /* ignore */ }
    state.sessionRowId = null;
  }

  function audit(action, entity, entityRef, details) {
    var row = {
      actor_email: state.user.email || 'unknown',
      actor_role: state.user.role || '',
      session_ref: state.sessionRef,
      action: action,
      entity: entity || null,
      entity_ref: entityRef ? String(entityRef) : null,
      details: details || {}
    };
    req('POST', '/audit_log', [row], { Prefer: 'return=minimal' }).catch(function (e) {
      console.warn('Audit log failed', e.message);
    });
  }

  /* wrap the app's save actions so every change is attributed to a user */
  var AUDIT_ACTIONS = {
    saveItem: ['Inventory item saved', 'Inventory'],
    saveOrder: ['Sale invoice created', 'Sale invoice'],
    savePurchaseInvoice: ['Purchase invoice created', 'Purchase invoice'],
    saveQuotation: ['Quotation created', 'Quotation'],
    savePatient: ['Patient record saved', 'Patient'],
    saveDebitNote: ['Debit note created', 'Debit note'],
    saveCustomer: ['Customer saved', 'Customer'],
    saveSupplier: ['Supplier saved', 'Supplier'],
    savePurchase: ['Purchase order saved', 'Purchase'],
    savePayout: ['Payment out recorded', 'Payout'],
    saveExpense: ['Expense recorded', 'Expense'],
    saveIncome: ['Other income recorded', 'Income'],
    saveCashBank: ['Cash/bank entry recorded', 'Cash & bank'],
    saveSalary: ['Salary recorded', 'Salary'],
    saveAttendance: ['Attendance recorded', 'Attendance'],
    saveSettings: ['Settings updated', 'Settings'],
    saveEditRecord: ['Record edited', 'Record'],
    saveGrowSettings: ['Growth settings updated', 'Settings'],
    deleteRecord: ['Record deleted', 'Record']
  };

  function wrapAuditedActions() {
    Object.keys(AUDIT_ACTIONS).forEach(function (fn) {
      var original = window[fn];
      if (typeof original !== 'function' || original.__pvWrapped) return;
      var meta = AUDIT_ACTIONS[fn];
      var wrapped = function () {
        var out = original.apply(this, arguments);
        try {
          var ref = arguments.length ? String(arguments[0]) : '';
          audit(meta[0], meta[1], ref, { args: Array.prototype.slice.call(arguments).slice(0, 3) });
        } catch (e) { /* ignore */ }
        return out;
      };
      wrapped.__pvWrapped = true;
      window[fn] = wrapped;
    });
  }

  /* ---------- Activity log & backup screens ---------- */
  function navButton(label, icon, tab, colour) {
    var b = document.createElement('button');
    b.className = 'w-full flex items-center space-x-3 px-3 py-2.5 rounded-lg hover:bg-slate-800 hover:text-white transition group';
    b.setAttribute('onclick', "showTab('" + tab + "')");
    b.innerHTML = '<i class="fa-solid ' + icon + ' w-5 ' + colour + '"></i><span>' + label + '</span>';
    return b;
  }

  function injectScreens() {
    if (document.getElementById('tab-activitylog')) return;
    var settingsBtn = document.querySelector('[onclick="showTab(\'settings\')"]');
    if (settingsBtn && settingsBtn.parentNode) {
      settingsBtn.parentNode.insertBefore(navButton('Users', 'fa-users-gear', 'users', 'text-orange-400'), settingsBtn);
      settingsBtn.parentNode.insertBefore(navButton('Activity Log', 'fa-clipboard-list', 'activitylog', 'text-emerald-400'), settingsBtn);
      settingsBtn.parentNode.insertBefore(navButton('Cloud Backup', 'fa-cloud-arrow-up', 'cloudbackup', 'text-sky-400'), settingsBtn);
    }
    var host = document.getElementById('tab-dashboard');
    if (!host || !host.parentNode) return;

    var act = document.createElement('div');
    act.id = 'tab-activitylog';
    act.className = 'tab-content hidden space-y-4';
    act.innerHTML =
      '<div class="flex items-center justify-between flex-wrap gap-2">' +
      '<div><h4 class="text-sm font-extrabold text-slate-800">Audit Trail</h4>' +
      '<p class="text-[11px] text-slate-500">Every action is recorded against the signed-in user.</p></div>' +
      '<div class="flex items-center gap-2">' +
      '<input type="date" id="pvAuditDate" class="border border-slate-300 rounded-lg px-2 py-1.5 text-xs" />' +
      '<button onclick="PVCloud.loadActivity()" class="px-3 py-1.5 bg-slate-900 text-white rounded-lg text-xs font-bold">Refresh</button>' +
      '</div></div>' +
      '<div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">' +
      '<div class="px-4 py-2 border-b border-slate-100 text-[11px] font-bold uppercase text-slate-400">Login history</div>' +
      '<div class="overflow-x-auto"><table class="w-full text-xs"><thead class="bg-slate-50 text-slate-500"><tr>' +
      '<th class="text-left px-4 py-2">Email</th><th class="text-left px-4 py-2">Role</th>' +
      '<th class="text-left px-4 py-2">Signed in</th><th class="text-left px-4 py-2">Signed out</th>' +
      '<th class="text-left px-4 py-2">IP</th><th class="text-left px-4 py-2">Device</th>' +
      '</tr></thead><tbody id="pvLoginBody"></tbody></table></div></div>' +
      '<div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">' +
      '<div class="px-4 py-2 border-b border-slate-100 text-[11px] font-bold uppercase text-slate-400">Actions</div>' +
      '<div class="overflow-x-auto"><table class="w-full text-xs"><thead class="bg-slate-50 text-slate-500"><tr>' +
      '<th class="text-left px-4 py-2">Time</th><th class="text-left px-4 py-2">User</th>' +
      '<th class="text-left px-4 py-2">Role</th><th class="text-left px-4 py-2">Action</th>' +
      '<th class="text-left px-4 py-2">Area</th>' +
      '</tr></thead><tbody id="pvAuditBody"></tbody></table></div></div>';

    var backup = document.createElement('div');
    backup.id = 'tab-cloudbackup';
    backup.className = 'tab-content hidden space-y-4';
    backup.innerHTML =
      '<div id="pvSyncCards" class="grid grid-cols-1 md:grid-cols-4 gap-4"></div>' +
      '<div class="flex flex-wrap gap-2">' +
      '<button onclick="PVCloud.syncNow()" class="px-3 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg text-xs font-bold shadow">Sync now</button>' +
      '<button onclick="PVCloud.verify()" class="px-3 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-bold shadow">Verify cloud data</button>' +
      '<button onclick="PVCloud.exportSnapshot()" class="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow">Export cloud snapshot</button>' +
      '<button onclick="PVCloud.reload()" class="px-3 py-2 border border-slate-300 rounded-lg text-xs font-bold text-slate-700">Reload from cloud</button>' +
      '</div>' +
      '<div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">' +
      '<div class="px-4 py-2 border-b border-slate-100 text-[11px] font-bold uppercase text-slate-400">Verification — records on this device vs cloud</div>' +
      '<div class="overflow-x-auto"><table class="w-full text-xs"><thead class="bg-slate-50 text-slate-500"><tr>' +
      '<th class="text-left px-4 py-2">Data</th><th class="text-left px-4 py-2">On device</th>' +
      '<th class="text-left px-4 py-2">In cloud</th><th class="text-left px-4 py-2">Status</th>' +
      '</tr></thead><tbody id="pvVerifyBody"><tr><td class="px-4 py-3 text-slate-400" colspan="4">Press “Verify cloud data”.</td></tr></tbody></table></div></div>';

    var users = document.createElement('div');
    users.id = 'tab-users';
    users.className = 'tab-content hidden space-y-4';
    users.innerHTML =
      '<div class="flex items-center justify-between flex-wrap gap-2">' +
      '<div><h4 class="text-sm font-extrabold text-slate-800">Users</h4>' +
      '<p class="text-[11px] text-slate-500">Tap a user to see everything they created. Unpaid users cannot add new records.</p></div>' +
      '<button onclick="PVCloud.loadUsers()" class="px-3 py-1.5 bg-slate-900 text-white rounded-lg text-xs font-bold">Refresh</button>' +
      '</div>' +
      '<div id="pvUsersList" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3"></div>' +
      '<div id="pvUserDetail" class="space-y-3"></div>';

    host.parentNode.appendChild(users);
    host.parentNode.appendChild(act);
    host.parentNode.appendChild(backup);
    renderBackupTab();
  }

  function card(label, value, tone) {
    return '<div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">' +
      '<div class="text-[10px] font-bold uppercase text-slate-400">' + label + '</div>' +
      '<div class="text-sm font-black mt-1 ' + (tone || 'text-slate-900') + '">' + value + '</div></div>';
  }

  function renderBackupTab() {
    var box = document.getElementById('pvSyncCards');
    if (!box) return;
    var last = state.lastSync || (localStorage.getItem('pvLastCloudSync') ? new Date(localStorage.getItem('pvLastCloudSync')) : null);
    box.innerHTML =
      card('Cloud connection', state.online ? 'Connected' : 'Offline', state.online ? 'text-emerald-600' : 'text-rose-600') +
      card('Sync status', state.syncing ? 'Saving…' : (state.pending ? 'Changes pending' : 'All changes saved'),
        state.syncing ? 'text-amber-600' : (state.pending ? 'text-amber-600' : 'text-emerald-600')) +
      card('Last saved to cloud', last ? last.toLocaleString() : 'Never') +
      card('Signed in as', (state.user.email || '—') + (state.user.role ? ' · ' + state.user.role : ''));
    var err = state.lastError;
    if (err) box.innerHTML += card('Last error', String(err).slice(0, 120), 'text-rose-600');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  async function loadActivity() {
    var dateEl = document.getElementById('pvAuditDate');
    var filter = '';
    if (dateEl && dateEl.value) {
      filter = '&created_at=gte.' + dateEl.value + 'T00:00:00&created_at=lt.' + dateEl.value + 'T23:59:59';
    }
    var loginFilter = filter.replace(/created_at/g, 'logged_in_at');
    try {
      var logins = await get('/login_sessions?select=*&order=logged_in_at.desc&limit=200' + loginFilter);
      var lb = document.getElementById('pvLoginBody');
      if (lb) {
        lb.innerHTML = (logins || []).length ? logins.map(function (r) {
          return '<tr class="border-t border-slate-100"><td class="px-4 py-2 font-semibold">' + esc(r.email) + '</td>' +
            '<td class="px-4 py-2">' + esc(r.role) + '</td>' +
            '<td class="px-4 py-2">' + new Date(r.logged_in_at).toLocaleString() + '</td>' +
            '<td class="px-4 py-2">' + (r.logged_out_at ? new Date(r.logged_out_at).toLocaleString() : '—') + '</td>' +
            '<td class="px-4 py-2">' + esc(r.ip_address || '—') + '</td>' +
            '<td class="px-4 py-2 text-slate-500 truncate max-w-[220px]">' + esc(r.user_agent || '') + '</td></tr>';
        }).join('') : '<tr><td class="px-4 py-3 text-slate-400" colspan="6">No sign-ins recorded yet.</td></tr>';
      }
      var events = await get('/audit_log?select=*&order=created_at.desc&limit=300' + filter);
      var ab = document.getElementById('pvAuditBody');
      if (ab) {
        ab.innerHTML = (events || []).length ? events.map(function (r) {
          return '<tr class="border-t border-slate-100"><td class="px-4 py-2">' + new Date(r.created_at).toLocaleString() + '</td>' +
            '<td class="px-4 py-2 font-semibold">' + esc(r.actor_email) + '</td>' +
            '<td class="px-4 py-2">' + esc(r.actor_role) + '</td>' +
            '<td class="px-4 py-2">' + esc(r.action) + '</td>' +
            '<td class="px-4 py-2 text-slate-500">' + esc(r.entity || '—') + '</td></tr>';
        }).join('') : '<tr><td class="px-4 py-3 text-slate-400" colspan="5">No actions recorded yet.</td></tr>';
      }
      state.online = true;
    } catch (e) {
      state.lastError = e.message;
      state.online = false;
    }
    renderBackupTab();
  }

  async function verify() {
    var body = document.getElementById('pvVerifyBody');
    if (body) body.innerHTML = '<tr><td class="px-4 py-3 text-slate-400" colspan="4">Checking…</td></tr>';
    var rows = '';
    try {
      for (var name in COLL) {
        var res = await fetch(REST + '/' + COLL[name] + '?select=id', {
          headers: headers({ Prefer: 'count=exact', Range: '0-0' })
        });
        var range = res.headers.get('content-range') || '/0';
        var cloudCount = parseInt(range.split('/')[1], 10) || 0;
        var localCount = Array.isArray(userData[name]) ? userData[name].length : 0;
        var ok = cloudCount === localCount;
        rows += '<tr class="border-t border-slate-100"><td class="px-4 py-2 font-semibold">' + esc(LABELS[name] || name) + '</td>' +
          '<td class="px-4 py-2">' + localCount + '</td><td class="px-4 py-2">' + cloudCount + '</td>' +
          '<td class="px-4 py-2 font-bold ' + (ok ? 'text-emerald-600' : 'text-amber-600') + '">' +
          (ok ? 'In sync' : 'Needs sync') + '</td></tr>';
      }
      state.online = true;
    } catch (e) {
      state.lastError = e.message;
      state.online = false;
      rows = '<tr><td class="px-4 py-3 text-rose-600" colspan="4">Could not reach the cloud database.</td></tr>';
    }
    if (body) body.innerHTML = rows;
    audit('Cloud data verified', 'Backup', null, {});
    renderBackupTab();
  }

  async function exportSnapshot() {
    try {
      var snapshot = { app: 'Posvibe', source: 'Lovable Cloud', exportedAt: new Date().toISOString(), tables: {} };
      for (var name in COLL) {
        snapshot.tables[COLL[name]] = await get('/' + COLL[name] + '?select=*');
      }
      snapshot.tables.app_settings = await get('/app_settings?select=*');
      snapshot.tables.login_sessions = await get('/login_sessions?select=*&order=logged_in_at.desc&limit=1000');
      snapshot.tables.audit_log = await get('/audit_log?select=*&order=created_at.desc&limit=2000');
      var blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'posvibe-cloud-snapshot-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      audit('Cloud snapshot exported', 'Backup', null, {});
    } catch (e) {
      alert('Snapshot export failed: ' + e.message);
    }
  }

  async function reload() {
    overlay(true, 'Reloading data from the cloud…');
    try {
      var fresh = await pullData();
      applyFresh(fresh);
      if (typeof renderAllData === 'function') renderAllData();
      state.online = true;
      state.pending = false;
    } catch (e) {
      state.lastError = e.message;
      state.online = false;
    }
    overlay(false);
    renderBackupTab();
  }

  function applyFresh(fresh) {
    for (var k in fresh) {
      if (fresh[k] !== undefined && fresh[k] !== null) userData[k] = fresh[k];
    }
    if (!userData.purchaseinvoices) userData.purchaseinvoices = [];
    localStorage.setItem('bizManagerData', JSON.stringify(userData));
  }

  /* ---------- users: per-user records & paid/unpaid gate ---------- */
  var usersCache = [];

  async function loadUsers() {
    var box = document.getElementById('pvUsersList');
    if (box) box.innerHTML = '<div class="text-xs text-slate-400">Loading users…</div>';
    try {
      var accounts = await get('/app_accounts?select=role_key,email,is_verified,display_name,created_at&order=created_at.asc');
      usersCache = accounts || [];
      var sessions = await get('/login_sessions?select=email,logged_in_at&order=logged_in_at.desc&limit=500') || [];
      var lastSeen = {};
      sessions.forEach(function (s) { if (!lastSeen[s.email]) lastSeen[s.email] = s.logged_in_at; });
      var isAdmin = String(state.user.role || '').toLowerCase().indexOf('admin') !== -1;
      if (box) {
        box.innerHTML = usersCache.length ? usersCache.map(function (u) {
          var paid = u.is_verified !== false;
          return '<div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">' +
            '<div class="flex items-start justify-between gap-2">' +
            '<button onclick="PVCloud.openUser(\'' + esc(u.email) + '\')" class="text-left">' +
            '<div class="text-sm font-extrabold text-slate-800">' + esc(u.display_name || u.email) + '</div>' +
            '<div class="text-[11px] text-slate-500">' + esc(u.email) + ' · ' + esc(u.role_key) + '</div>' +
            '<div class="text-[11px] text-slate-400 mt-1">Last sign-in: ' +
            (lastSeen[u.email] ? new Date(lastSeen[u.email]).toLocaleString() : '—') + '</div></button>' +
            '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold ' +
            (paid ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700') + '">' +
            (paid ? 'Paid' : 'Not paid') + '</span></div>' +
            '<div class="flex gap-2 mt-3">' +
            '<button onclick="PVCloud.openUser(\'' + esc(u.email) + '\')" class="px-2.5 py-1.5 bg-slate-900 text-white rounded-lg text-[11px] font-bold">View records</button>' +
            (isAdmin ? '<button onclick="PVCloud.setVerified(\'' + esc(u.role_key) + '\',' + (paid ? 'false' : 'true') + ')" class="px-2.5 py-1.5 rounded-lg text-[11px] font-bold border ' +
              (paid ? 'border-rose-300 text-rose-600' : 'border-emerald-300 text-emerald-600') + '">' +
              (paid ? 'Mark unpaid' : 'Mark paid') + '</button>' : '') +
            '</div></div>';
        }).join('') : '<div class="text-xs text-slate-400">No accounts yet.</div>';
      }
      state.online = true;
    } catch (e) {
      state.lastError = e.message;
      if (box) box.innerHTML = '<div class="text-xs text-rose-600">Could not load users: ' + esc(e.message) + '</div>';
    }
    renderBackupTab();
  }

  async function setVerified(roleKey, value) {
    try {
      await req('PATCH', '/app_accounts?role_key=eq.' + encodeURIComponent(roleKey), { is_verified: !!value });
      audit(value ? 'User marked paid' : 'User marked unpaid', 'Account', roleKey, {});
      await pullAccounts();
      var acc = localAccounts();
      for (var k in acc) {
        if (acc[k].email === state.user.email) state.user.verified = acc[k].verified !== false;
      }
      loadUsers();
    } catch (e) {
      alert('Could not update this user: ' + e.message);
    }
  }

  async function openUser(email) {
    var host = document.getElementById('pvUserDetail');
    if (!host) return;
    host.innerHTML = '<div class="text-xs text-slate-400">Loading records for ' + esc(email) + '…</div>';
    var names = Object.keys(COLL);
    try {
      var results = await Promise.all(names.map(function (n) {
        return get('/' + COLL[n] + '?select=id,record,created_at&created_by=eq.' + encodeURIComponent(email) +
          '&order=created_at.desc&limit=100');
      }));
      var html = '<div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">' +
        '<div class="text-sm font-extrabold text-slate-800">Records created by ' + esc(email) + '</div>' +
        '<p class="text-[11px] text-slate-500">Grouped by section. Latest 100 per section.</p></div>';
      names.forEach(function (n, i) {
        var rows = results[i] || [];
        html += '<div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">' +
          '<div class="px-4 py-2 border-b border-slate-100 flex items-center justify-between">' +
          '<span class="text-[11px] font-bold uppercase text-slate-500">' + esc(LABELS[n] || n) + '</span>' +
          '<span class="text-[11px] font-black ' + (rows.length ? 'text-slate-800' : 'text-slate-300') + '">' + rows.length + '</span></div>' +
          (rows.length ? '<div class="overflow-x-auto"><table class="w-full text-xs"><tbody>' + rows.slice(0, 25).map(function (r) {
            var rec = r.record || {};
            var title = rec.invoiceNo || rec.number || rec.name || rec.title || rec.customer || rec.item || rec.id || '—';
            var amount = rec.total != null ? rec.total : (rec.amount != null ? rec.amount : '');
            return '<tr class="border-t border-slate-100"><td class="px-4 py-2 font-semibold">' + esc(title) + '</td>' +
              '<td class="px-4 py-2 text-slate-500">' + esc(amount) + '</td>' +
              '<td class="px-4 py-2 text-slate-400">' + new Date(r.created_at).toLocaleString() + '</td></tr>';
          }).join('') + '</tbody></table></div>' : '')
          + '</div>';
      });
      host.innerHTML = html;
      host.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      host.innerHTML = '<div class="text-xs text-rose-600">Could not load this user: ' + esc(e.message) + '</div>';
    }
  }

  function currentUserPaid() {
    if (state.user.verified === false) return false;
    return true;
  }

  function showUnpaidMessage() {
    var el = document.getElementById('pvUnpaidModal');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pvUnpaidModal';
      el.className = 'fixed inset-0 z-[120] bg-slate-900/60 flex items-center justify-center p-4';
      el.innerHTML =
        '<div class="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6 text-center">' +
        '<div class="w-12 h-12 mx-auto rounded-full bg-rose-100 flex items-center justify-center">' +
        '<i class="fa-solid fa-triangle-exclamation text-rose-600"></i></div>' +
        '<h3 class="text-base font-extrabold text-slate-800 mt-3">You have not paid</h3>' +
        '<p class="text-xs text-slate-500 mt-1">Your account is not verified yet, so new records cannot be added. Please contact the administrator to activate your account.</p>' +
        '<button onclick="document.getElementById(\'pvUnpaidModal\').remove()" class="mt-4 w-full px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-bold">OK</button></div>';
      document.body.appendChild(el);
    } else {
      el.classList.remove('hidden');
    }
  }

  var GATED_MODALS = /invoice|order|item|product|purchase|expense|customer|supplier|quotation|patient|debit|payout|income|salary|attendance|cash/i;

  function applyPaidGate() {
    var originalOpen = window.openModal;
    if (typeof originalOpen === 'function' && !originalOpen.__pvGated) {
      var gatedOpen = function (modalId) {
        if (!currentUserPaid() && GATED_MODALS.test(String(modalId))) { showUnpaidMessage(); return; }
        return originalOpen.apply(this, arguments);
      };
      gatedOpen.__pvGated = true;
      window.openModal = gatedOpen;
    }
    Object.keys(AUDIT_ACTIONS).forEach(function (fn) {
      var original = window[fn];
      if (typeof original !== 'function' || original.__pvGated) return;
      var gated = function (e) {
        if (!currentUserPaid()) {
          if (e && e.preventDefault) e.preventDefault();
          showUnpaidMessage();
          return false;
        }
        return original.apply(this, arguments);
      };
      gated.__pvGated = true;
      window[fn] = gated;
    });
  }

  /* ---------- boot ---------- */
  async function boot() {
    overlay(true);
    wrapAuditedActions();
    try {
      await pullAccounts();
      var fresh = await pullData();
      applyFresh(fresh);
      state.online = true;
      state.lastSync = new Date();
    } catch (e) {
      state.online = false;
      state.lastError = e.message;
      console.error('Cloud load failed', e);
    }
    state.ready = true;
    injectScreens();
    applyPaidGate();

    /* persist every change to the cloud */
    var originalSave = window.saveData;
    if (typeof originalSave === 'function' && !originalSave.__pvWrapped) {
      var wrappedSave = function () {
        var out = originalSave.apply(this, arguments);
        queueSync();
        return out;
      };
      wrappedSave.__pvWrapped = true;
      window.saveData = wrappedSave;
    }

    /* keep tab titles and lazy loading for the new screens */
    var originalShowTab = window.showTab;
    if (typeof originalShowTab === 'function' && !originalShowTab.__pvWrapped) {
      var wrappedTab = function (tabId) {
        var out = originalShowTab.apply(this, arguments);
        var titleEl = document.getElementById('currentTabTitle');
        if (tabId === 'activitylog') {
          if (titleEl) titleEl.innerText = 'Activity Log & Audit Trail';
          loadActivity();
        } else if (tabId === 'cloudbackup') {
          if (titleEl) titleEl.innerText = 'Cloud Backup & Verification';
          renderBackupTab();
          verify();
        } else if (tabId === 'users') {
          if (titleEl) titleEl.innerText = 'Users';
          loadUsers();
        }
        return out;
      };
      wrappedTab.__pvWrapped = true;
      window.showTab = wrappedTab;
    }

    /* account creation now writes to the cloud with a hashed password */
    window.pvSaveAccount = async function (e) {
      if (e && e.preventDefault) e.preventDefault();
      var kind = (typeof pvQueue !== 'undefined' && pvQueue.length) ? pvQueue[0] : 'admin';
      var email = document.getElementById('pvNewEmail').value.trim();
      var pass = document.getElementById('pvNewPassword').value.trim();
      overlay(true, 'Saving account to the cloud…');
      try {
        await saveAccount(kind, email, pass);
      } catch (err) {
        overlay(false);
        alert('Could not save the account: ' + err.message);
        return;
      }
      overlay(false);
      if (typeof pvQueue !== 'undefined') pvQueue.shift();
      if (typeof pvNextForm === 'function') pvNextForm();
    };

    /* sign in against cloud accounts, then record the login */
    window.handleLogin = async function (e) {
      if (e && e.preventDefault) e.preventDefault();
      var email = document.getElementById('loginEmail').value.trim();
      var pass = document.getElementById('loginPassword').value.trim();
      var errEl = document.getElementById('loginError');
      var acc = localAccounts();
      var hash = await sha256(pass);
      var role = null;
      if (acc.admin && email === acc.admin.email && (acc.admin.hash === hash || acc.admin.password === pass)) role = 'Admin';
      else if (acc.employee && email === acc.employee.email && (acc.employee.hash === hash || acc.employee.password === pass)) role = 'Employee';
      else if (email === 'admin@gmail.com' && pass === 'zefzef') role = 'Admin';
      else if (email === 'employee@gmail.com' && (pass === 'aefaef' || pass === 'aef aef')) role = 'Employee';
      else if (email === 'employ@gmail.com' && pass === 'adiladil') role = 'Staff Manager';
      if (!role) { errEl.classList.remove('hidden'); return; }

      var matched = null;
      for (var k in acc) { if (acc[k] && acc[k].email === email) matched = acc[k]; }
      state.user = { email: email, role: role, verified: matched ? matched.verified !== false : true };

      currentUserRole = role;
      sessionStorage.setItem('bizManagerRole', role);
      document.getElementById('loginScreen').classList.add('hidden');
      document.getElementById('appContainer').classList.remove('hidden');
      if (typeof updateRoleUI === 'function') updateRoleUI();
      if (typeof renderAllData === 'function') renderAllData();
      injectScreens();
      applyPaidGate();
      logLogin(email, role);
      renderBackupTab();
      if (!currentUserPaid()) showUnpaidMessage();
    };

    var originalLogout = window.logout;
    if (typeof originalLogout === 'function' && !originalLogout.__pvWrapped) {
      var wrappedLogout = function () {
        logLogout();
        return originalLogout.apply(this, arguments);
      };
      wrappedLogout.__pvWrapped = true;
      window.logout = wrappedLogout;
    }

    overlay(false);
    if (typeof pvBackToStart === 'function') pvBackToStart();
    if (typeof pvRefreshLogin === 'function') pvRefreshLogin();
  }

  window.PVCloud = {
    state: state,
    syncNow: runSync,
    verify: verify,
    exportSnapshot: exportSnapshot,
    loadActivity: loadActivity,
    loadUsers: loadUsers,
    openUser: openUser,
    setVerified: setVerified,
    isPaid: currentUserPaid,
    reload: reload,
    audit: audit
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 0); });
  } else {
    setTimeout(boot, 0);
  }
})();
