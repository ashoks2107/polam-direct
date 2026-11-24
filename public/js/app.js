/* Polam Direct — single-page frontend (vanilla JS, hash routing) */
(() => {
  'use strict';

  const LANGS = [['te', 'తెలుగు'], ['en', 'English'], ['hi', 'हिन्दी']];
  const LOCALE = { te: 'te-IN', en: 'en-IN', hi: 'hi-IN' };
  const I = window.I18N;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const app = $('#app');
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  };

  /* ---------------- State ---------------- */
  const S = {
    lang: I[store.get('pd-lang')] ? store.get('pd-lang') : 'te',
    user: null,
    cat: null,
    cart: (() => {
      try {
        const c = JSON.parse(store.get('pd-cart') || '[]');
        return Array.isArray(c) ? c.filter(x => Number.isInteger(x.id) && x.qty > 0) : [];
      } catch (e) { return []; }
    })(),
    filters: { q: '', category: '', district: '', organic: false, sort: '' },
    farmerTab: 'orders',
    farmerShowAll: false
  };

  /* ---------------- i18n + formatting ---------------- */
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Returns HTML-safe text: translations are trusted, params are escaped.
  function t(key, params) {
    const s = (I[S.lang] && I[S.lang][key]) ?? I.en[key] ?? key;
    return params ? s.replace(/\{(\w+)\}/g, (_, k) => esc(params[k] ?? '')) : s;
  }
  const money = v => '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const qtyFmt = v => String(Math.round(v * 100) / 100);
  const fmtDate = s => {
    try { const [y, m, d] = s.split('-').map(Number); return new Intl.DateTimeFormat(LOCALE[S.lang], { day: 'numeric', month: 'short' }).format(new Date(y, m - 1, d)); }
    catch (e) { return s; }
  };
  const fmtDateTime = s => {
    try { return new Intl.DateTimeFormat(LOCALE[S.lang], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(s.replace(' ', 'T') + 'Z')); }
    catch (e) { return s; }
  };
  const loc = (obj) => obj ? (obj[S.lang] || obj.en) : '';
  const itemOf = key => key && S.cat.items[key];
  const productName = p => { const it = itemOf(p.catalog_key); return it ? loc(it) : p.name; };
  const productSub = p => { const it = itemOf(p.catalog_key); return it ? (S.lang === 'en' ? it.te : it.en) : ''; };
  const unitName = u => loc(S.cat.units[u]) || u;
  const catName = c => loc(S.cat.categories[c]) || c;
  const districtName = d => { const x = S.cat.districts[d]; return x ? (S.lang === 'te' ? x.te : x.en) : (d || ''); };
  const placeName = (village, district) => [village, districtName(district)].filter(Boolean).join(', ');
  const emojiOf = p => { const it = itemOf(p.catalog_key); return it ? it.emoji : (S.cat.categories[p.category] || {}).emoji || '🧺'; };
  const stepFor = unit => (unit === 'kg' || unit === 'litre') ? 0.5 : 1;

  /* ---------------- API ---------------- */
  async function api(method, url, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
    let res;
    try { res = await fetch(url, opts); } catch (e) { throw { code: 'err_network' }; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw { code: data.error || 'err_generic', params: data.params || {}, status: res.status };
    return data;
  }
  function errText(e) {
    const p = { ...(e && e.params) };
    if (p.key && itemOf(p.key)) p.name = loc(itemOf(p.key));
    return t((e && e.code) || 'err_generic', p);
  }

  /* ---------------- UI helpers ---------------- */
  let toastTimer;
  function toast(html, isErr) {
    const el = $('#toast');
    el.innerHTML = html;
    el.classList.toggle('err', !!isErr);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
  }
  const go = h => { if (location.hash === h) router(); else location.hash = h; };
  const currentPath = () => (location.hash.slice(1) || '/').split('?')[0];

  /* ---------------- Cart ---------------- */
  const saveCart = () => { store.set('pd-cart', JSON.stringify(S.cart)); renderHeader(); };
  const cartQty = id => (S.cart.find(c => c.id === id) || {}).qty || 0;
  function setCartQty(id, qty) {
    qty = Math.round(qty * 100) / 100;
    const i = S.cart.findIndex(c => c.id === id);
    if (qty <= 0) { if (i >= 0) S.cart.splice(i, 1); }
    else if (i >= 0) S.cart[i].qty = qty;
    else S.cart.push({ id, qty });
    saveCart();
  }

  /* ---------------- Header / chrome ---------------- */
  function renderLangSwitch() {
    $('#langSwitch').innerHTML = LANGS.map(([k, label]) =>
      `<button type="button" data-lang="${k}" aria-pressed="${k === S.lang}" lang="${k}">${label}</button>`).join('');
  }

  function renderHeader() {
    const u = S.user, cnt = S.cart.length, links = [];
    links.push(`<a href="#/" data-r="/">🏪 ${t('nav_market')}</a>`);
    if (!u || u.role === 'consumer') links.push(`<a href="#/cart" data-r="/cart">🛒 ${t('nav_cart')}${cnt ? `<span class="count">${cnt}</span>` : ''}</a>`);
    if (u && u.role === 'consumer') links.push(`<a href="#/orders" data-r="/orders">📦 ${t('nav_orders')}</a>`);
    if (u && u.role === 'farmer') links.push(`<a href="#/farmer" data-r="/farmer">👨‍🌾 ${t('nav_dashboard')}</a>`);
    if (u) {
      links.push(`<a href="#/profile" data-r="/profile">👤 ${esc(u.name.split(' ')[0])}</a>`);
      links.push(`<button type="button" class="linkbtn" data-act="logout">${t('nav_logout')}</button>`);
    } else {
      links.push(`<a href="#/login" data-r="/login">${t('nav_login')}</a>`);
      links.push(`<a href="#/register" class="btn btn-sm" data-r="/register">${t('nav_register')}</a>`);
    }
    $('#nav').innerHTML = links.join('');
    const p = currentPath();
    $$('#nav a[data-r]').forEach(a => a.classList.toggle('active', a.dataset.r === p));
    $('#brandName').textContent = I[S.lang].app_name;
    $('#brandTag').textContent = I[S.lang].tagline;
    $('#footName').textContent = I[S.lang].app_name;
    $('#footText').textContent = I[S.lang].footer_text;
    $$('#langSwitch button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === S.lang)));
    document.title = `${I[S.lang].app_name} · ${I[S.lang].tagline}`;
  }

  function setLang(l) {
    if (!I[l] || l === S.lang) return;
    S.lang = l;
    store.set('pd-lang', l);
    document.documentElement.lang = l;
    if (S.user) api('PATCH', '/api/me', { lang: l }).then(r => { S.user = r.user; }).catch(() => {});
    router(true);
  }

  /* ---------------- Shared fragments ---------------- */
  function buyControls(p, compact) {
    if (S.user && S.user.role === 'farmer') return '';
    const step = stepFor(p.unit), inCart = cartQty(p.id);
    return `
      <div class="buy" data-id="${p.id}" data-step="${step}" data-max="${p.quantity}">
        <div class="stepper">
          <button type="button" data-act="dec" aria-label="-">−</button>
          <input type="number" value="${step === 0.5 ? 1 : 1}" min="${step}" step="${step}" max="${p.quantity}" inputmode="decimal" aria-label="${t('quantity')}">
          <button type="button" data-act="inc" aria-label="+">+</button>
        </div>
        <button type="button" class="btn${inCart ? ' in-cart' : ''}" data-act="add">${inCart ? `✓ ${qtyFmt(inCart)}` : `🛒 ${t(compact ? 'add_short' : 'add_to_cart')}`}</button>
      </div>`;
  }

  function productCard(p, market) {
    const m = p.catalog_key && market[`${p.catalog_key}|${p.unit}`];
    const best = m && m.n > 1 && p.price <= m.min;
    const sub = productSub(p);
    return `
      <article class="pcard">
        <a class="pimg cat-${esc(p.category)}" href="#/product/${p.id}" aria-label="${esc(productName(p))}">
          <span>${emojiOf(p)}</span>${p.organic ? `<em class="tag-org">🌱 ${t('organic')}</em>` : ''}
        </a>
        <div class="pbody">
          <h3><a href="#/product/${p.id}">${esc(productName(p))}</a></h3>
          ${sub ? `<p class="psub">${esc(sub)}</p>` : ''}
          <div class="price"><b>${money(p.price)}</b><span>/ ${unitName(p.unit)}</span>${best ? `<em class="tag-best">⭐ ${t('best_price')}</em>` : ''}</div>
          ${m && m.n > 1 ? `<p class="avg">${t('avg_price', { p: m.avg })}</p>` : ''}
          <p class="farmer">👨‍🌾 ${esc(p.farmer.name)} · ${esc(placeName(p.farmer.village, p.farmer.district))}</p>
          <p class="meta">${t('available', { n: `${qtyFmt(p.quantity)} ${unitName(p.unit)}` })}${p.harvest_date ? ' · ' + t('harvested', { d: fmtDate(p.harvest_date) }) : ''}</p>
          ${buyControls(p, true)}
        </div>
      </article>`;
  }

  function districtOptions(selected, withAll) {
    const opts = Object.values(S.cat.districts).map(d =>
      `<option value="${d.key}"${d.key === selected ? ' selected' : ''}>${esc(S.lang === 'te' ? `${d.te} · ${d.en}` : d.en)}</option>`).join('');
    return (withAll ? `<option value="">${t('all_districts')}</option>` : `<option value="">${t('choose_district')}</option>`) + opts;
  }

  function requireRole(role) {
    if (!S.user) { go('#/login?next=' + encodeURIComponent(currentPath())); return false; }
    if (role && S.user.role !== role) {
      app.innerHTML = `<div class="page"><div class="card empty"><span class="big">🔒</span>${t('err_forbidden')}<p style="margin-top:16px"><a class="btn" href="#/">${t('nav_market')}</a></p></div></div>`;
      return false;
    }
    return true;
  }

  /* ---------------- Views ---------------- */
  async function viewHome() {
    const f = S.filters, u = S.user;
    const sellBtn = !u ? `<a class="btn btn-lg btn-outline" href="#/register?role=farmer">👨‍🌾 ${t('hero_cta_sell')}</a>`
      : u.role === 'farmer' ? `<a class="btn btn-lg btn-outline" href="#/farmer">👨‍🌾 ${t('nav_dashboard')}</a>` : '';
    app.innerHTML = `
      <section class="hero">
        <div>
          <h1>${t('hero_title')}</h1>
          <p class="lead">${t('hero_sub')}</p>
          <div class="cta"><button type="button" class="btn btn-lg" data-act="to-market">🛒 ${t('hero_cta_buy')}</button>${sellBtn}</div>
        </div>
        <div class="hero-stats" id="heroStats">
          <div class="stat"><b>–</b><span>${t('stat_farmers')}</span></div>
          <div class="stat"><b>–</b><span>${t('stat_products')}</span></div>
          <div class="stat"><b>–</b><span>${t('stat_districts')}</span></div>
          <div class="stat accent"><b>0%</b><span>${t('stat_commission')}</span></div>
        </div>
      </section>
      <section class="features">
        <div class="feature"><div class="ic">🤝</div><h3>${t('feat1_t')}</h3><p>${t('feat1_d')}</p></div>
        <div class="feature"><div class="ic">🌱</div><h3>${t('feat2_t')}</h3><p>${t('feat2_d')}</p></div>
        <div class="feature"><div class="ic">⚖️</div><h3>${t('feat3_t')}</h3><p>${t('feat3_d')}</p></div>
        <div class="feature"><div class="ic">💵</div><h3>${t('feat4_t')}</h3><p>${t('feat4_d')}</p></div>
      </section>
      <section class="market" id="market">
        <h2>${t('market_title')}</h2>
        <div class="filters">
          <input class="input search" type="search" id="fq" placeholder="${t('search_ph')}" value="${esc(f.q)}" aria-label="${t('search_ph')}">
          <select class="select" id="fdist" aria-label="${t('district')}">${districtOptions(f.district, true)}</select>
          <select class="select" id="fsort" aria-label="Sort">
            <option value="">${t('sort_new')}</option>
            <option value="price_asc"${f.sort === 'price_asc' ? ' selected' : ''}>${t('sort_price_asc')}</option>
            <option value="price_desc"${f.sort === 'price_desc' ? ' selected' : ''}>${t('sort_price_desc')}</option>
          </select>
          <label class="check"><input type="checkbox" id="forg"${f.organic ? ' checked' : ''}> 🌱 ${t('organic_only')}</label>
        </div>
        <div class="chips" id="fcat">
          <button type="button" class="chip" data-cat="" aria-pressed="${!f.category}">${t('all')}</button>
          ${Object.values(S.cat.categories).map(c => `<button type="button" class="chip" data-cat="${c.key}" aria-pressed="${f.category === c.key}">${c.emoji} ${esc(loc(c))}</button>`).join('')}
        </div>
        <div class="grid" id="grid">${'<div class="skel"></div>'.repeat(4)}</div>
      </section>
      <section class="how" aria-label="${t('how_title')}">
        <div class="card"><h3>👨‍🌾 ${t('how_farmers')}</h3><ol><li>${t('how_f1')}</li><li>${t('how_f2')}</li><li>${t('how_f3')}</li></ol></div>
        <div class="card"><h3>🛒 ${t('how_consumers')}</h3><ol><li>${t('how_c1')}</li><li>${t('how_c2')}</li><li>${t('how_c3')}</li></ol></div>
      </section>`;

    api('GET', '/api/stats').then(s => {
      const b = $$('#heroStats .stat b');
      if (b.length) { b[0].textContent = s.farmers; b[1].textContent = s.products; b[2].textContent = s.districts; }
    }).catch(() => {});

    let timer;
    $('#fq').addEventListener('input', e => { clearTimeout(timer); timer = setTimeout(() => { f.q = e.target.value.trim(); loadGrid(); }, 250); });
    $('#fdist').addEventListener('change', e => { f.district = e.target.value; loadGrid(); });
    $('#fsort').addEventListener('change', e => { f.sort = e.target.value; loadGrid(); });
    $('#forg').addEventListener('change', e => { f.organic = e.target.checked; loadGrid(); });
    $('#fcat').addEventListener('click', e => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      f.category = b.dataset.cat;
      $$('#fcat .chip').forEach(c => c.setAttribute('aria-pressed', String(c === b)));
      loadGrid();
    });
    await loadGrid();
  }

  let gridSeq = 0;
  async function loadGrid() {
    const f = S.filters, seq = ++gridSeq;
    const qs = new URLSearchParams();
    if (f.q) qs.set('q', f.q);
    if (f.category) qs.set('category', f.category);
    if (f.district) qs.set('district', f.district);
    if (f.organic) qs.set('organic', '1');
    if (f.sort) qs.set('sort', f.sort);
    try {
      const { products, market } = await api('GET', '/api/products?' + qs);
      if (seq !== gridSeq || !$('#grid')) return;
      $('#grid').innerHTML = products.length ? products.map(p => productCard(p, market)).join('')
        : `<div class="card empty" style="grid-column:1/-1"><span class="big">🧺</span>${t('no_products')}</div>`;
    } catch (e) {
      if ($('#grid')) $('#grid').innerHTML = `<div class="card empty" style="grid-column:1/-1">${errText(e)}</div>`;
    }
  }

  async function viewProduct({ params }) {
    app.innerHTML = `<p class="loading">${t('loading')}</p>`;
    let data;
    try { data = await api('GET', '/api/products/' + params[0]); }
    catch (e) { app.innerHTML = `<div class="page"><div class="card empty"><span class="big">🧺</span>${errText(e)}</div></div>`; return; }
    const { product: p, more, market } = data;
    const it = itemOf(p.catalog_key);
    const m = p.catalog_key && market[`${p.catalog_key}|${p.unit}`];
    const best = m && m.n > 1 && p.price <= m.min;
    const farmerBlock = S.user && S.user.role === 'farmer'
      ? `<p class="note warn">ℹ️ ${t('farmers_cannot_buy')}</p>` : buyControls(p);
    app.innerHTML = `
      <div class="page">
        <p><a href="#/" class="linkbtn" style="padding-left:0">${t('back')}</a></p>
        <div class="detail">
          <div class="pimg cat-${esc(p.category)}"><span>${emojiOf(p)}</span>${p.organic ? `<em class="tag-org">🌱 ${t('organic')}</em>` : ''}</div>
          <div>
            <p class="muted small" style="margin:0">${S.cat.categories[p.category].emoji} ${esc(catName(p.category))}</p>
            <h1 style="margin:0">${esc(productName(p))}</h1>
            ${it ? `<div class="names"><span lang="te">${esc(it.te)}</span><span lang="en">${esc(it.en)}</span><span lang="hi">${esc(it.hi)}</span></div>` : ''}
            <div class="price"><b>${money(p.price)}</b><span>/ ${unitName(p.unit)}</span>${best ? `<em class="tag-best">⭐ ${t('best_price')}</em>` : ''}</div>
            ${m && m.n > 1 ? `<p class="avg">${t('avg_price', { p: m.avg })}</p>` : ''}
            <p class="meta" style="margin-top:8px">${t('available', { n: `${qtyFmt(p.quantity)} ${unitName(p.unit)}` })}${p.harvest_date ? ' · ' + t('harvested', { d: fmtDate(p.harvest_date) }) : ''}</p>
            ${p.description ? `<p>${esc(p.description)}</p>` : ''}
            <div class="farmer-card">
              <span class="av">👨‍🌾</span>
              <div><b>${esc(p.farmer.name)}</b><span class="muted small">${t('farmer')} · ${esc(placeName(p.farmer.village, p.farmer.district))}</span></div>
            </div>
            ${farmerBlock}
            <p class="note">🤝 ${t('zero_comm_note')}</p>
            <p class="note info">📞 ${t('phone_after_order')}</p>
          </div>
        </div>
        ${more.length ? `<h2 style="margin-top:40px">${t('more_from', { name: p.farmer.name })}</h2><div class="grid">${more.map(x => productCard(x, market)).join('')}</div>` : ''}
      </div>`;
  }

  const DEMO = [
    ['9000000001', 'Venkata Ramaiah', 'farmer', 'guntur'],
    ['9000000002', 'Lakshmi Devi', 'farmer', 'east_godavari'],
    ['9000000003', 'Srinivasa Reddy', 'farmer', 'anantapur'],
    ['9000000009', 'Anil Kumar', 'consumer', 'visakhapatnam']
  ];

  function viewLogin({ query }) {
    if (S.user) { go(S.user.role === 'farmer' ? '#/farmer' : '#/'); return; }
    app.innerHTML = `
      <div class="auth">
        <div class="card">
          <h1>${t('login_title')}</h1>
          <form class="form" id="loginForm" novalidate>
            <label class="field"><span>${t('phone')}</span><input class="input" name="phone" inputmode="numeric" autocomplete="tel" maxlength="14" required placeholder="98xxxxxxxx"></label>
            <label class="field"><span>${t('password')}</span><input class="input" name="password" type="password" autocomplete="current-password" required></label>
            <p class="form-error" id="err"></p>
            <button class="btn btn-lg btn-block" type="submit">${t('login_btn')}</button>
          </form>
          <p class="alt">${t('no_account')} <a href="#/register">${t('nav_register')}</a></p>
        </div>
        <div class="card demo">
          <h3>🧪 ${t('demo_accounts')}</h3>
          <ul>${DEMO.map(([ph, nm, role, d]) => `<li><span>${role === 'farmer' ? '👨‍🌾' : '🛒'} <b>${esc(nm)}</b> · ${t('role_' + role)} · ${esc(districtName(d))}<br><span class="muted small">${ph}</span></span><button type="button" class="btn btn-sm btn-ghost" data-phone="${ph}">${t('use')}</button></li>`).join('')}</ul>
        </div>
      </div>`;
    const form = $('#loginForm');
    $$('.demo [data-phone]').forEach(b => b.addEventListener('click', () => {
      form.phone.value = b.dataset.phone; form.password.value = 'demo1234'; form.requestSubmit();
    }));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const { user } = await api('POST', '/api/login', { phone: form.phone.value, password: form.password.value });
        onLoggedIn(user, query.get('next'));
      } catch (err) { $('#err').innerHTML = errText(err); btn.disabled = false; }
    });
  }

  function onLoggedIn(user, next) {
    S.user = user;
    if (I[user.lang] && user.lang !== S.lang) { S.lang = user.lang; store.set('pd-lang', user.lang); document.documentElement.lang = user.lang; }
    toast(t('welcome', { name: user.name }));
    const safeNext = next && /^\/[a-z0-9/]*$/i.test(next) ? next : null;
    go('#' + (safeNext || (user.role === 'farmer' ? '/farmer' : '/')));
  }

  function viewRegister({ query }) {
    if (S.user) { go('#/'); return; }
    const role = query.get('role') === 'farmer' ? 'farmer' : query.get('role') === 'consumer' ? 'consumer' : '';
    app.innerHTML = `
      <div class="auth">
        <div class="card">
          <h1>${t('register_title')}</h1>
          <form class="form" id="regForm" novalidate>
            <div class="field"><span>${t('i_am')}</span>
              <div class="roles">
                <label class="role"><input type="radio" name="role" value="farmer"${role === 'farmer' ? ' checked' : ''}><span class="rc"><span class="e">👨‍🌾</span><b>${t('role_farmer')}</b><small>${t('role_farmer_d')}</small></span></label>
                <label class="role"><input type="radio" name="role" value="consumer"${role === 'consumer' ? ' checked' : ''}><span class="rc"><span class="e">🛒</span><b>${t('role_consumer')}</b><small>${t('role_consumer_d')}</small></span></label>
              </div>
            </div>
            <label class="field"><span>${t('name')}</span><input class="input" name="name" autocomplete="name" maxlength="60" required></label>
            <div class="row2">
              <label class="field"><span>${t('phone')}</span><input class="input" name="phone" inputmode="numeric" autocomplete="tel" maxlength="14" required placeholder="98xxxxxxxx"></label>
              <label class="field"><span>${t('password')}</span><input class="input" name="password" type="password" autocomplete="new-password" minlength="6" required><small>${t('password_hint')}</small></label>
            </div>
            <div class="row2">
              <label class="field"><span>${t('district')}</span><select class="select" name="district" required>${districtOptions('', false)}</select></label>
              <label class="field"><span>${t('village')}</span><input class="input" name="village" maxlength="80"></label>
            </div>
            <label class="field"><span>${t('language')}</span><select class="select" name="lang">${LANGS.map(([k, l]) => `<option value="${k}"${k === S.lang ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
            <p class="form-error" id="err"></p>
            <button class="btn btn-lg btn-block" type="submit">${t('register_btn')}</button>
          </form>
          <p class="alt">${t('have_account')} <a href="#/login">${t('nav_login')}</a></p>
        </div>
      </div>`;
    const form = $('#regForm');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(form));
      const err = $('#err');
      if (!fd.role) { err.innerHTML = t('err_role'); return; }
      if (!fd.name || fd.name.trim().length < 2) { err.innerHTML = t('err_name'); return; }
      if (!/^[6-9]\d{9}$/.test(String(fd.phone).replace(/\D/g, '').slice(-10))) { err.innerHTML = t('err_phone'); return; }
      if (!fd.password || fd.password.length < 6) { err.innerHTML = t('err_password'); return; }
      if (!fd.district) { err.innerHTML = t('err_district'); return; }
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try { const { user } = await api('POST', '/api/register', fd); onLoggedIn(user); }
      catch (ex) { err.innerHTML = errText(ex); btn.disabled = false; }
    });
  }

  async function viewCart() {
    if (!S.cart.length) {
      app.innerHTML = `<div class="page"><h1>${t('cart_title')}</h1><div class="card empty"><span class="big">🛒</span>${t('cart_empty')}<p style="margin-top:16px"><a class="btn" href="#/">${t('continue_shopping')}</a></p></div></div>`;
      return;
    }
    app.innerHTML = `<p class="loading">${t('loading')}</p>`;
    let products;
    try { products = (await api('GET', '/api/products?ids=' + S.cart.map(c => c.id).join(','))).products; }
    catch (e) { app.innerHTML = `<div class="page"><div class="card empty">${errText(e)}</div></div>`; return; }
    const byId = new Map(products.map(p => [p.id, p]));
    // Drop items that disappeared, clamp to available stock.
    let changed = false;
    S.cart = S.cart.filter(c => {
      const p = byId.get(c.id);
      if (!p || p.quantity <= 0) { changed = true; return false; }
      if (c.qty > p.quantity) { c.qty = p.quantity; changed = true; }
      return true;
    });
    if (changed) { saveCart(); toast(t('err_stock', { name: '' }).replace(/:\s*$/, ''), true); }
    if (!S.cart.length) { viewCart(); return; }

    const render = () => {
      const groups = new Map();
      S.cart.forEach(c => {
        const p = byId.get(c.id);
        if (!groups.has(p.farmer_id)) groups.set(p.farmer_id, { farmer: p.farmer, lines: [] });
        groups.get(p.farmer_id).lines.push({ p, qty: c.qty });
      });
      let grand = 0;
      const groupsHtml = [...groups.values()].map(g => {
        const sub = g.lines.reduce((s, l) => s + l.p.price * l.qty, 0);
        grand += sub;
        return `
          <div class="card farm-group">
            <h3>👨‍🌾 ${t('from_farmer', { name: g.farmer.name })} <span class="muted small">· ${esc(placeName(g.farmer.village, g.farmer.district))}</span></h3>
            ${g.lines.map(({ p, qty }) => `
              <div class="line" data-id="${p.id}" data-step="${stepFor(p.unit)}" data-max="${p.quantity}">
                <span class="em cat-${esc(p.category)}">${emojiOf(p)}</span>
                <span class="nm"><b>${esc(productName(p))}</b><small>${money(p.price)} / ${unitName(p.unit)}</small></span>
                <span class="ctl">
                  <span class="stepper">
                    <button type="button" data-act="cdec" aria-label="-">−</button>
                    <input type="number" value="${qtyFmt(qty)}" min="${stepFor(p.unit)}" step="${stepFor(p.unit)}" max="${p.quantity}" inputmode="decimal" aria-label="${t('quantity')}">
                    <button type="button" data-act="cinc" aria-label="+">+</button>
                  </span>
                  <span class="lt">${money(p.price * qty)}</span>
                  <button type="button" class="linkbtn" data-act="cdel">✕ ${t('remove')}</button>
                </span>
              </div>`).join('')}
            <div class="subtotal"><span>${t('total')}</span><span>${money(sub)}</span></div>
          </div>`;
      }).join('');

      let checkout;
      if (!S.user) checkout = `<p>${t('login_to_checkout')}</p><a class="btn btn-lg btn-block" href="#/login?next=/cart">${t('nav_login')}</a><p class="alt"><a href="#/register?role=consumer">${t('nav_register')}</a></p>`;
      else if (S.user.role !== 'consumer') checkout = `<p class="note warn">ℹ️ ${t('farmers_cannot_buy')}</p>`;
      else {
        const addr = [S.user.village, districtName(S.user.district)].filter(Boolean).join(', ');
        checkout = `
          <form class="form" id="coForm" novalidate>
            <div class="field"><span>${t('delivery_method')}</span>
              <div class="opts">
                <label class="opt"><input type="radio" name="delivery_method" value="pickup" checked> 🚜 ${t('pickup')}</label>
                <label class="opt"><input type="radio" name="delivery_method" value="delivery"> 🏠 ${t('home_delivery')}</label>
              </div>
            </div>
            <label class="field" id="addrField" hidden><span>${t('address')}</span><textarea class="input" name="address" rows="2" maxlength="300">${esc(addr)}</textarea></label>
            <div class="field"><span>${t('payment')}</span>
              <div class="opts">
                <label class="opt"><input type="radio" name="payment_method" value="cod" checked> 💵 ${t('cod')}</label>
                <label class="opt"><input type="radio" name="payment_method" value="upi"> 📱 ${t('upi')}</label>
              </div>
            </div>
            <label class="field"><span>${t('note')}</span><input class="input" name="note" maxlength="300"></label>
            <p class="form-error" id="err"></p>
            <button class="btn btn-lg btn-block" type="submit">✅ ${t('place_order')} · ${money(grand)}</button>
          </form>`;
      }

      app.innerHTML = `
        <div class="page">
          <div class="page-head"><h1>${t('cart_title')}</h1><a href="#/" class="btn btn-ghost btn-sm">${t('continue_shopping')}</a></div>
          <div class="cart-grid">
            <div>${groupsHtml}</div>
            <div class="card" style="position:sticky;top:96px">
              <h2>${t('checkout')}</h2>
              <div class="grand"><span>${t('total')}</span><b>${money(grand)}</b></div>
              <p class="note">🤝 ${t('zero_comm_note')}</p>
              <p class="muted small" style="margin:10px 0 16px">${t('split_note')}</p>
              ${checkout}
            </div>
          </div>
        </div>`;

      $$('.line').forEach(line => {
        const id = Number(line.dataset.id), step = Number(line.dataset.step), maxQ = Number(line.dataset.max), input = $('input', line);
        const apply = v => { v = Math.min(maxQ, Math.max(step, Math.round(v / step) * step)); setCartQty(id, v); render(); };
        line.addEventListener('click', e => {
          const a = e.target.closest('[data-act]');
          if (!a) return;
          if (a.dataset.act === 'cinc') apply(Number(input.value) + step);
          if (a.dataset.act === 'cdec') { const v = Number(input.value) - step; if (v < step) { setCartQty(id, 0); S.cart.length ? render() : viewCart(); } else apply(v); }
          if (a.dataset.act === 'cdel') { setCartQty(id, 0); S.cart.length ? render() : viewCart(); }
        });
        input.addEventListener('change', () => apply(Number(input.value) || step));
      });

      const form = $('#coForm');
      if (form) {
        form.addEventListener('change', () => { $('#addrField').hidden = form.delivery_method.value !== 'delivery'; });
        form.addEventListener('submit', async e => {
          e.preventDefault();
          const fd = Object.fromEntries(new FormData(form));
          if (fd.delivery_method === 'delivery' && (fd.address || '').trim().length < 5) { $('#err').innerHTML = t('err_address'); return; }
          const btn = form.querySelector('button[type=submit]');
          btn.disabled = true;
          try {
            await api('POST', '/api/orders', { ...fd, items: S.cart.map(c => ({ product_id: c.id, qty: c.qty })) });
            S.cart = [];
            saveCart();
            toast('✅ ' + t('order_placed'));
            go('#/orders');
          } catch (ex) {
            btn.disabled = false;
            $('#err').innerHTML = errText(ex);
            if (ex.code === 'err_stock') setTimeout(viewCart, 1800);
          }
        });
      }
    };
    render();
  }

  function orderCard(o, as) {
    const steps = ['placed', 'accepted', 'ready', 'delivered'], idx = steps.indexOf(o.status);
    const progress = idx < 0
      ? `<span class="status st-${o.status}">${t('status_' + o.status)}</span>`
      : `<ol class="timeline">${steps.map((s, i) => `<li class="${i <= idx ? 'done' : ''}${i === idx ? ' cur' : ''}">${t('status_' + s)}</li>`).join('')}</ol>`;
    const who = as === 'consumer'
      ? { label: t('farmer'), icon: '👨‍🌾', name: o.farmer_name, phone: o.farmer_phone, place: placeName(o.farmer_village, o.farmer_district) }
      : { label: t('customer'), icon: '🛒', name: o.customer_name, phone: o.customer_phone, place: placeName(o.customer_village, o.customer_district) };
    let actions = '';
    if (as === 'consumer' && o.status === 'placed') actions = `<button type="button" class="btn btn-danger btn-sm" data-cancel="${o.id}">${t('cancel_order')}</button>`;
    if (as === 'farmer') {
      const b = (st, label, cls = 'btn btn-sm') => `<button type="button" class="${cls}" data-order="${o.id}" data-status="${st}">${label}</button>`;
      if (o.status === 'placed') actions = b('accepted', '✅ ' + t('accept')) + b('rejected', t('reject'), 'btn btn-danger btn-sm');
      if (o.status === 'accepted') actions = b('ready', '🚚 ' + t('mark_ready')) + b('rejected', t('reject'), 'btn btn-danger btn-sm');
      if (o.status === 'ready') actions = b('delivered', '📦 ' + t('mark_delivered'));
    }
    return `
      <article class="card">
        <div class="order-head">
          <h3>${t('order_no', { id: o.id })} <span class="muted small">· ${fmtDateTime(o.created_at)}</span></h3>
          <span class="order-total">${money(o.total)}</span>
        </div>
        ${progress}
        <ul class="order-items">${o.items.map(i => `<li><span>${emojiOf(i)} ${esc(itemOf(i.catalog_key) ? loc(itemOf(i.catalog_key)) : i.name)} × ${qtyFmt(i.qty)} ${unitName(i.unit)}</span><span>${money(i.price * i.qty)}</span></li>`).join('')}</ul>
        <div class="order-meta">
          <div><b>${who.label}</b>${who.icon} ${esc(who.name)}<br><span class="muted">${esc(who.place)}</span><br><a href="tel:+91${esc(who.phone)}">📞 ${esc(who.phone)}</a></div>
          <div><b>${t('delivery_method')}</b>${o.delivery_method === 'delivery' ? '🏠 ' + t('home_delivery') : '🚜 ' + t('pickup')}${o.address ? `<br><span class="muted">${esc(o.address)}</span>` : ''}</div>
          <div><b>${t('payment')}</b>${o.payment_method === 'upi' ? '📱 ' + t('upi') : '💵 ' + t('cod')}${o.note ? `<br><span class="muted">“${esc(o.note)}”</span>` : ''}</div>
        </div>
        ${actions ? `<div class="order-actions">${actions}</div>` : ''}
      </article>`;
  }

  async function viewOrders() {
    if (!requireRole('consumer')) return;
    app.innerHTML = `<p class="loading">${t('loading')}</p>`;
    let orders;
    try { orders = (await api('GET', '/api/orders')).orders; }
    catch (e) { app.innerHTML = `<div class="page"><div class="card empty">${errText(e)}</div></div>`; return; }
    app.innerHTML = `
      <div class="page">
        <div class="page-head"><h1>${t('orders_title')}</h1></div>
        ${orders.length ? `<div class="orders">${orders.map(o => orderCard(o, 'consumer')).join('')}</div>`
          : `<div class="card empty"><span class="big">📦</span>${t('no_orders')}<p style="margin-top:16px"><a class="btn" href="#/">${t('continue_shopping')}</a></p></div>`}
      </div>`;
    $$('[data-cancel]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm(I[S.lang].confirm_cancel)) return;
      try { await api('POST', `/api/orders/${b.dataset.cancel}/cancel`); viewOrders(); }
      catch (e) { toast(errText(e), true); }
    }));
  }

  async function viewFarmer() {
    if (!requireRole('farmer')) return;
    app.innerHTML = `<p class="loading">${t('loading')}</p>`;
    let summary, orders, mine;
    try {
      [summary, { orders }, mine] = await Promise.all([api('GET', '/api/farmer/summary'), api('GET', '/api/farmer/orders'), api('GET', '/api/farmer/products')]);
    } catch (e) { app.innerHTML = `<div class="page"><div class="card empty">${errText(e)}</div></div>`; return; }
    const { products, market } = mine;
    const tab = S.farmerTab;
    const activeOrders = orders.filter(o => ['placed', 'accepted', 'ready'].includes(o.status));
    const shown = S.farmerShowAll ? orders : activeOrders;

    const ordersHtml = `
      <div class="toolbar">
        <div class="seg" role="group">
          <button type="button" data-showall="0" aria-pressed="${!S.farmerShowAll}">${t('show_active')} (${activeOrders.length})</button>
          <button type="button" data-showall="1" aria-pressed="${S.farmerShowAll}">${t('show_all')} (${orders.length})</button>
        </div>
      </div>
      ${shown.length ? `<div class="orders">${shown.map(o => orderCard(o, 'farmer')).join('')}</div>`
        : `<div class="card empty"><span class="big">📭</span>${t('no_farm_orders')}</div>`}`;

    const productsHtml = `
      <div class="toolbar"><span></span><button type="button" class="btn" data-act="new-product">${t('add_product')}</button></div>
      ${products.length ? `<div class="plist">${products.map(p => {
        const m = p.catalog_key && market[`${p.catalog_key}|${p.unit}`];
        return `
        <div class="prow${p.quantity <= 0 ? ' oos' : ''}">
          <span class="em cat-${esc(p.category)}">${emojiOf(p)}</span>
          <span class="nm"><b>${esc(productName(p))}${p.organic ? ' 🌱' : ''}</b>
            <small>${t('available', { n: `${qtyFmt(p.quantity)} ${unitName(p.unit)}` })}${p.harvest_date ? ' · ' + t('harvested', { d: fmtDate(p.harvest_date) }) : ''}</small>
            ${p.quantity <= 0 ? `<span class="oos-tag">${t('out_of_stock')}</span>` : ''}
          </span>
          <span class="pr">${money(p.price)}<small>/ ${unitName(p.unit)}</small>${m && m.n > 1 ? `<small>${t('avg_price', { p: m.avg })}</small>` : ''}</span>
          <span class="act">
            <button type="button" class="btn btn-ghost btn-sm" data-edit="${p.id}">✏️ ${t('edit')}</button>
            <button type="button" class="btn btn-danger btn-sm" data-del="${p.id}">${t('delete')}</button>
          </span>
        </div>`;
      }).join('')}</div>` : `<div class="card empty"><span class="big">🌱</span>${t('no_my_products')}</div>`}`;

    app.innerHTML = `
      <div class="page">
        <div class="page-head"><h1>👨‍🌾 ${t('dash_title')}</h1><span class="muted">${esc(S.user.name)} · ${esc(placeName(S.user.village, S.user.district))}</span></div>
        <div class="tiles">
          <div class="tile"><b>${summary.active}</b><span>${t('stat_active')}</span></div>
          <div class="tile hot"><b>${summary.pending}</b><span>${t('stat_pending')}</span></div>
          <div class="tile money"><b>${money(summary.earned)}</b><span>${t('stat_earned')}</span></div>
          <div class="tile money"><b>${money(summary.month)}</b><span>${t('stat_month')}</span></div>
        </div>
        <div class="tabs" role="tablist">
          <button type="button" class="tab" role="tab" data-tab="orders" aria-selected="${tab === 'orders'}">📦 ${t('tab_orders')}${summary.pending ? `<span class="count">${summary.pending}</span>` : ''}</button>
          <button type="button" class="tab" role="tab" data-tab="products" aria-selected="${tab === 'products'}">🧺 ${t('tab_products')} (${products.length})</button>
        </div>
        <div>${tab === 'orders' ? ordersHtml : productsHtml}</div>
      </div>
      ${productDialog()}`;

    $$('[data-tab]').forEach(b => b.addEventListener('click', () => { S.farmerTab = b.dataset.tab; viewFarmer(); }));
    $$('[data-showall]').forEach(b => b.addEventListener('click', () => { S.farmerShowAll = b.dataset.showall === '1'; viewFarmer(); }));
    $$('[data-order]').forEach(b => b.addEventListener('click', async () => {
      if (b.dataset.status === 'rejected' && !confirm(I[S.lang].confirm_reject)) return;
      b.disabled = true;
      try { await api('PATCH', `/api/farmer/orders/${b.dataset.order}`, { status: b.dataset.status }); toast('✅ ' + t('saved')); viewFarmer(); }
      catch (e) { toast(errText(e), true); b.disabled = false; }
    }));
    $$('[data-del]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm(I[S.lang].confirm_delete)) return;
      try { await api('DELETE', `/api/farmer/products/${b.dataset.del}`); toast(t('deleted')); viewFarmer(); }
      catch (e) { toast(errText(e), true); }
    }));
    const newBtn = $('[data-act="new-product"]');
    if (newBtn) newBtn.addEventListener('click', () => openProductDialog(null, market));
    $$('[data-edit]').forEach(b => b.addEventListener('click', () => openProductDialog(products.find(p => p.id === Number(b.dataset.edit)), market)));
  }

  function productDialog() {
    const cats = Object.values(S.cat.categories);
    const itemOpts = cats.map(c => `<optgroup label="${c.emoji} ${esc(loc(c))}">${Object.values(S.cat.items).filter(i => i.cat === c.key)
      .map(i => `<option value="${i.key}">${i.emoji} ${esc(loc(i))}${S.lang !== 'en' ? ' · ' + esc(i.en) : ''}</option>`).join('')}</optgroup>`).join('');
    return `
      <dialog id="pdlg">
        <form class="form" id="pform" novalidate>
          <h2 id="pdlgTitle"></h2>
          <label class="field"><span>${t('product')}</span>
            <select class="select" name="catalog_key" required><option value="">${t('choose_product')}</option>${itemOpts}<option value="__other">✍️ ${t('other_product')}</option></select>
          </label>
          <div class="row2" id="customFields" hidden>
            <label class="field"><span>${t('custom_name')}</span><input class="input" name="name" maxlength="60"></label>
            <label class="field"><span>${t('category')}</span><select class="select" name="category">${cats.map(c => `<option value="${c.key}">${c.emoji} ${esc(loc(c))}</option>`).join('')}</select></label>
          </div>
          <div class="row2">
            <label class="field"><span>${t('price')}</span><input class="input" name="price" type="number" min="1" step="0.5" inputmode="decimal" required></label>
            <label class="field"><span>${t('unit')}</span><select class="select" name="unit">${Object.values(S.cat.units).map(u => `<option value="${u.key}">${esc(loc(u))}</option>`).join('')}</select></label>
          </div>
          <p class="hint" id="priceHint"></p>
          <div class="row2">
            <label class="field"><span>${t('qty_available')}</span><input class="input" name="quantity" type="number" min="0" step="0.5" inputmode="decimal" required></label>
            <label class="field"><span>${t('harvest_date')}</span><input class="input" name="harvest_date" type="date"></label>
          </div>
          <label class="check"><input type="checkbox" name="organic"> 🌱 ${t('is_organic')}</label>
          <label class="field"><span>${t('description')}</span><textarea class="input" name="description" rows="2" maxlength="500"></textarea></label>
          <p class="form-error" id="perr"></p>
          <div class="actions">
            <button type="button" class="btn btn-ghost" data-act="close-dlg">${t('cancel')}</button>
            <button type="submit" class="btn">💾 ${t('save')}</button>
          </div>
        </form>
      </dialog>`;
  }

  function openProductDialog(p, market) {
    const dlg = $('#pdlg'), form = $('#pform');
    $('#pdlgTitle').innerHTML = p ? t('edit_product') : t('add_product').replace(/^\+\s*/, '');
    form.reset();
    $('#perr').innerHTML = '';
    if (p) {
      form.catalog_key.value = p.catalog_key || '__other';
      form.name.value = p.catalog_key ? '' : p.name;
      form.category.value = p.category;
      form.unit.value = p.unit;
      form.price.value = p.price;
      form.quantity.value = p.quantity;
      form.harvest_date.value = p.harvest_date || '';
      form.organic.checked = p.organic;
      form.description.value = p.description || '';
    } else {
      form.harvest_date.value = new Date().toISOString().slice(0, 10);
    }
    const sync = (fromSelect) => {
      const key = form.catalog_key.value;
      $('#customFields').hidden = key !== '__other';
      if (fromSelect && itemOf(key)) form.unit.value = itemOf(key).unit;
      const m = itemOf(key) && market[`${key}|${form.unit.value}`];
      $('#priceHint').innerHTML = !itemOf(key) ? '' : m ? '💡 ' + t('price_hint', { avg: m.avg, min: m.min, n: m.n }) : '💡 ' + t('price_hint_none');
    };
    form.catalog_key.onchange = () => sync(true);
    form.unit.onchange = () => sync(false);
    sync(false);
    $('[data-act="close-dlg"]', dlg).onclick = () => dlg.close();
    form.onsubmit = async e => {
      e.preventDefault();
      const key = form.catalog_key.value;
      if (!key) { $('#perr').innerHTML = t('err_product'); return; }
      const body = {
        catalog_key: key === '__other' ? null : key,
        name: form.name.value, category: form.category.value, unit: form.unit.value,
        price: form.price.value, quantity: form.quantity.value, harvest_date: form.harvest_date.value,
        organic: form.organic.checked, description: form.description.value
      };
      if (!(Number(body.price) > 0)) { $('#perr').innerHTML = t('err_price'); return; }
      if (body.quantity === '' || !(Number(body.quantity) >= 0)) { $('#perr').innerHTML = t('err_qty'); return; }
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        if (p) await api('PUT', `/api/farmer/products/${p.id}`, body);
        else await api('POST', '/api/farmer/products', body);
        dlg.close();
        toast('✅ ' + t('saved'));
        S.farmerTab = 'products';
        viewFarmer();
      } catch (ex) { $('#perr').innerHTML = errText(ex); btn.disabled = false; }
    };
    dlg.showModal();
  }

  function viewProfile() {
    if (!requireRole(null)) return;
    const u = S.user;
    app.innerHTML = `
      <div class="auth">
        <div class="card">
          <h1>${u.role === 'farmer' ? '👨‍🌾' : '🛒'} ${t('profile_title')}</h1>
          <p class="muted">${t('role_' + u.role)} · 📞 ${esc(u.phone)}</p>
          <form class="form" id="profForm" novalidate>
            <label class="field"><span>${t('name')}</span><input class="input" name="name" value="${esc(u.name)}" maxlength="60" required></label>
            <div class="row2">
              <label class="field"><span>${t('district')}</span><select class="select" name="district">${districtOptions(u.district, false)}</select></label>
              <label class="field"><span>${t('village')}</span><input class="input" name="village" value="${esc(u.village)}" maxlength="80"></label>
            </div>
            <label class="field"><span>${t('language')}</span><select class="select" name="lang">${LANGS.map(([k, l]) => `<option value="${k}"${k === S.lang ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
            <p class="form-error" id="err"></p>
            <button class="btn btn-lg" type="submit">💾 ${t('save')}</button>
          </form>
        </div>
      </div>`;
    const form = $('#profForm');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(form));
      try {
        const { user } = await api('PATCH', '/api/me', fd);
        S.user = user;
        toast('✅ ' + t('saved'));
        if (user.lang !== S.lang) setLang(user.lang); else renderHeader();
      } catch (ex) { $('#err').innerHTML = errText(ex); }
    });
  }

  /* ---------------- Global events ---------------- */
  document.addEventListener('click', async e => {
    const langBtn = e.target.closest('[data-lang]');
    if (langBtn) { setLang(langBtn.dataset.lang); return; }

    const act = e.target.closest('[data-act]');
    if (!act) return;
    const a = act.dataset.act;
    if (a === 'logout') {
      try { await api('POST', '/api/logout'); } catch (err) { /* ignore */ }
      S.user = null;
      toast(t('logged_out'));
      go('#/');
      return;
    }
    if (a === 'to-market') { $('#market').scrollIntoView({ behavior: 'smooth' }); return; }

    const buy = act.closest('.buy');
    if (!buy) return;
    const id = Number(buy.dataset.id), step = Number(buy.dataset.step), maxQ = Number(buy.dataset.max), input = $('input', buy);
    const clamp = v => Math.min(maxQ, Math.max(step, Math.round(v / step) * step));
    if (a === 'inc') input.value = qtyFmt(clamp(Number(input.value) + step));
    if (a === 'dec') input.value = qtyFmt(clamp(Number(input.value) - step));
    if (a === 'add') {
      const want = clamp(Number(input.value) || step);
      const total = Math.min(maxQ, cartQty(id) + want);
      setCartQty(id, total);
      act.classList.add('in-cart');
      act.innerHTML = `✓ ${qtyFmt(total)}`;
      toast(`🛒 ${t('added_to_cart')}`);
    }
  });

  /* ---------------- Router ---------------- */
  const ROUTES = [
    [/^\/$/, viewHome],
    [/^\/product\/(\d+)$/, viewProduct],
    [/^\/login$/, viewLogin],
    [/^\/register$/, viewRegister],
    [/^\/cart$/, viewCart],
    [/^\/orders$/, viewOrders],
    [/^\/farmer$/, viewFarmer],
    [/^\/profile$/, viewProfile]
  ];
  let lastPath = null;
  async function router(keepScroll) {
    const [path, qs] = (location.hash.slice(1) || '/').split('?');
    const route = ROUTES.find(([re]) => re.test(path));
    if (!route) { location.hash = '#/'; return; }
    renderHeader();
    if (path !== lastPath && keepScroll !== true) window.scrollTo(0, 0);
    lastPath = path;
    try { await route[1]({ params: path.match(route[0]).slice(1), query: new URLSearchParams(qs || '') }); }
    catch (e) { console.error(e); app.innerHTML = `<div class="page"><div class="card empty">${errText(e)}</div></div>`; }
  }
  window.addEventListener('hashchange', () => router());

  /* ---------------- Boot ---------------- */
  async function boot() {
    document.documentElement.lang = S.lang;
    $('#year').textContent = new Date().getFullYear();
    renderLangSwitch();
    try {
      const raw = await (await fetch('/data/catalog.json')).json();
      const idx = arr => Object.fromEntries(arr.map(x => [x.key, x]));
      S.cat = { items: idx(raw.items), categories: idx(raw.categories), units: idx(raw.units), districts: idx(raw.districts) };
    } catch (e) {
      app.innerHTML = `<div class="page"><div class="card empty">${t('err_network')}</div></div>`;
      return;
    }
    try { S.user = (await api('GET', '/api/me')).user; } catch (e) { S.user = null; }
    if (S.user && !store.get('pd-lang') && I[S.user.lang]) { S.lang = S.user.lang; document.documentElement.lang = S.lang; }
    router();
  }
  boot();
})();
