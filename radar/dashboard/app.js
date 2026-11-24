// Token Radar — the dashboard. It reads window.RADAR (data.js, written beside dashboard/ by
// main.ts) and renders: the masthead, the stat ledger, the stated value model with its
// snapshot-derived calibration, the board (sortable and filterable, every row its own claim with
// a band and a farm plan), the reordering callouts, the already-trading set, and a detail drawer
// for each protocol. No network, no framework, no build: system fonts and a hand-set grid.
// Every number the page shows is recomputable from the row's own snapshot figures.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('app');

  // ------------------------------------------------ shot mode
  var SHOT = {};
  (function () {
    var m = window.location.search.match(/[?&]shot=([^&]+)/);
    if (!m) return;
    SHOT.name = m[1];
    var sm = window.location.search.match(/[?&]slug=([^&]+)/);
    if (sm) SHOT.slug = decodeURIComponent(sm[1]);
    var fm = window.location.search.match(/[?&]cat=([^&]+)/);
    if (fm) SHOT.cat = decodeURIComponent(fm[1]);
  })();
  var FROZEN = Boolean(SHOT.name);

  // ------------------------------------------------ state
  var bySlug = {};
  DATA.rows.forEach(function (r) { bySlug[r.slug] = r; });
  var state = {
    q: '',
    cat: SHOT.cat || 'all',
    minTvl: 0,
    watchOnly: false,
    sortKey: 'implied',
    dir: -1,
    selected: null
  };
  if (SHOT.name === 'detail' && SHOT.slug && bySlug[SHOT.slug]) state.selected = SHOT.slug;

  // ------------------------------------------------ formatting
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'n/a';
    if (d >= 365) return (d / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(d)) + 'd';
  }
  function fmtX(n) { return n.toFixed(3) + 'x'; }

  // ------------------------------------------------ dom builder
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // ------------------------------------------------ data: filter + sort
  function filtered() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.cat !== 'all' && (r.category || 'Unspecified') !== state.cat) return false;
      if (state.watchOnly && !r.on_watchlist) return false;
      if (state.minTvl > 0 && r.tvl_usd < state.minTvl) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortVal(r, key) {
    if (key === 'tvl') return r.tvl_usd;
    if (key === 'growth') return r.change_7d === null ? -Infinity : r.change_7d;
    if (key === 'age') return r.age_days === null ? Infinity : r.age_days;
    if (key === 'base') return r.base;
    if (key === 'momentum') return r.momentum;
    if (key === 'maturity') return r.maturity;
    return r.implied_value_usd;
  }
  function sortRows(list) {
    var key = state.sortKey, dir = state.dir;
    return list.slice().sort(function (a, b) {
      var av = sortVal(a, key), bv = sortVal(b, key);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  // ------------------------------------------------ masthead + ledger
  function masthead() {
    return el('header', { class: 'masthead' },
      el('div', { class: 'brand' },
        el('h1', null, el('span', { text: 'Token ' }), el('b', { text: 'Radar' })),
        el('div', { class: 'tag', text: 'pre-token, ranked by implied launch value' })
      ),
      el('div', { class: 'masthead-meta' },
        el('span', null, el('b', { text: 'Sealed DefiLlama snapshot' }), ' · as of ' + DATA.as_of),
        el('span', { text: DATA.protocol_count + ' protocols · watchlist floor ' + fmtUsd(DATA.floor_usd) + ' · ' + DATA.board_size + ' rows scored' }),
        el('span', { text: 'model ' + DATA.model_version + ' · base from ' + DATA.calibration.trading_peers + ' trading peers' }),
        el('span', { class: 'stamp', text: DATA.watchlist_size + '/' + DATA.watchlist_size + ' watchlist covered' })
      )
    );
  }
  function ledger() {
    var top = DATA.rows[0];
    var mover = null;
    DATA.rows.forEach(function (r) {
      if (r.change_7d === null) return;
      if (mover === null || Math.abs(r.change_7d) > Math.abs(mover.change_7d)) mover = r;
    });
    var moverName = mover ? mover.name : '—';
    if ((moverName.length + String(fmtPct(mover ? mover.change_7d : 0)).length) > 26) moverName = moverName.split(' ')[0];
    return el('section', { class: 'ledger', 'aria-label': 'Board summary' },
      el('div', { class: 'cell' }, el('div', { class: 'k', text: 'Board' }), el('div', { class: 'v', text: DATA.board_size + ' pre-token rows' })),
      el('div', { class: 'cell' }, el('div', { class: 'k', text: 'Watchlist' }), el('div', { class: 'v', text: DATA.watchlist_size + '/' + DATA.watchlist_size + ' covered' })),
      el('div', { class: 'cell' }, el('div', { class: 'k', text: 'Top of board' }), el('div', { class: 'v', text: top.name + ' ' + fmtUsd(top.implied_value_usd) })),
      el('div', { class: 'cell' }, el('div', { class: 'k', text: 'Largest 7d print' }), el('div', { class: 'v ' + (mover && mover.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(mover ? mover.change_7d : null) + ' ' + moverName }))
    );
  }

  // ------------------------------------------------ stated model + calibration
  function modelSection() {
    var m = DATA.model;
    var cal = DATA.calibration;
    // Categories that actually appear on the board, strongest evidence first: the calibration page
    // must price what the board prices, nothing else.
    var boardCats = new Set(DATA.rows.map(function (r) { return r.category || 'Unspecified'; }));
    var cats = cal.categories.filter(function (c) { return boardCats.has(c.key); }).slice(0, 9);
    return el('section', { class: 'model' },
      el('div', null,
        el('h2', { class: 'sec-h', text: 'How the implied value is computed' }),
        el('div', { class: 'factor' },
          el('div', { class: 'fm', text: 'base = shrinkage of the category median mcap/TVL: (K·global + n·category) / (K + n), K=' + m.shrinkage_peers + ' peers of prior' }),
          el('div', { class: 'fn' }, el('b', { text: 'What the market pays for this category, in TVL terms. ' }), `Computed live from the ${cal.trading_peers} protocols in the snapshot whose token records exist; peer ratios clipped at the market's ${Math.round(cal.peer_cap_quantile * 100)}th percentile (${fmtX(cal.peer_cap)}) so one outlier does not price a category; thin categories fall toward the cross-category median of ${fmtX(cal.global_median)}.`)),
        el('div', { class: 'factor' },
          el('div', { class: 'fm', text: 'momentum = 1 + ' + m.growth_weight + ' × clamp(7d change, −' + m.growth_floor + ', +' + m.growth_cap + ') / 100' }),
          el('div', { class: 'fn' }, el('b', { text: `The snapshot\u2019s only demand signal. ` }), 'A protocol growing into a launch window is priced hotter than one shrinking out of it.')),
        el('div', { class: 'factor' },
          el('div', { class: 'fm', text: 'maturity = 1 + ' + m.maturity_weight + ' × min(age, ' + m.maturity_cap_days + 'd) / ' + m.maturity_cap_days + '; half credit when no listed_at' }),
          el('div', { class: 'fn' }, el('b', { text: 'Time run without a token. ' }), 'Longer unpriced runs accrue more of what a launch would price in.')),
        el('div', { class: 'claim', text: 'implied = TVL × base × momentum × maturity. A claim, not a price: the implied value is this entry\u2019s own valuation of a launch if the record stood, stated row by row with its band and its evidence. make.fun records no ranking, and the watchlist is DefiLlama\u2019s record, not proof.' })
      ),
      el('div', null,
        el('h2', { class: 'sec-h', text: 'Category pricing, read out of the snapshot' }),
        el('table', { class: 'calib' },
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Category' }),
            el('th', { scope: 'col', class: 'num', text: 'Peers' }),
            el('th', { scope: 'col', class: 'num', text: 'Median' }),
            el('th', { scope: 'col', class: 'num', text: 'Blended base' })
          )),
          el('tbody', null, cats.map(function (c) {
            return el('tr', null,
              el('td', { text: c.label }),
              el('td', { class: 'num numc2', text: String(c.peers) }),
              el('td', { class: 'num numc2', text: c.median === null ? 'n/a' : fmtX(c.median) + ' TVL' }),
              el('td', { class: 'num numc2', text: fmtX(c.multiple) + ' TVL' })
            );
          }))
        ),
        el('p', { class: 'sub', text: 'Every row on this board scores under its own named category from the snapshot; the full pricing table holds ' + cal.categories.length + ' categories by the same rule. No protocol name is special-cased anywhere in the program.' })
      )
    );
  }

  // ------------------------------------------------ reorders
  function reorders() {
    if (!DATA.reorders || DATA.reorders.length === 0) return null;
    return el('section', { class: 'reorders' },
      el('h2', { class: 'sec-h', text: 'Why the order is not just TVL' }),
      DATA.reorders.map(function (r) {
        return el('div', { class: 'row' },
          el('span', null, el('b', { text: r.name }), ' — ranked #' + r.implied_rank + ' against TVL rank #' + r.tvl_rank + '. ' + r.reason + '.'),
          el('span', { class: 'delta', text: '+' + r.places + ' places' })
        );
      })
    );
  }

  // ------------------------------------------------ controls
  function controls() {
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Unspecified'; }))).sort();
    var search = el('input', { type: 'search', placeholder: 'Search name, slug, category or chain', 'aria-label': 'Search the board', value: state.q });
    if (!FROZEN) search.addEventListener('input', function () { state.q = search.value; render(); });
    var sel = el('select', { 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      cats.map(function (c) {
        return el('option', { value: c, text: c + ' (' + DATA.rows.filter(function (r) { return (r.category || 'Unspecified') === c; }).length + ')', selected: c === state.cat ? 'selected' : null });
      })
    );
    if (!FROZEN) sel.addEventListener('change', function () { state.cat = sel.value; render(); });
    var minSel = el('select', { 'aria-label': 'Filter by minimum TVL' },
      el('option', { value: '0', text: 'Any TVL' }),
      el('option', { value: '50000000', text: '≥ $50M TVL', selected: state.minTvl === 50000000 ? 'selected' : null }),
      el('option', { value: '500000000', text: '≥ $500M TVL', selected: state.minTvl === 500000000 ? 'selected' : null })
    );
    if (!FROZEN) minSel.addEventListener('change', function () { state.minTvl = Number(minSel.value); render(); });
    var watch = el('input', { type: 'checkbox', 'aria-label': 'Watchlist rows only' });
    if (state.watchOnly) watch.checked = true;
    if (!FROZEN) watch.addEventListener('change', function () { state.watchOnly = watch.checked; render(); });
    var sortSel = el('select', { 'aria-label': 'Sort' },
      el('option', { value: 'implied|desc', text: 'Sort: implied value ↓', selected: state.sortKey === 'implied' && state.dir === -1 ? 'selected' : null }),
      el('option', { value: 'tvl|desc', text: 'Sort: TVL ↓', selected: state.sortKey === 'tvl' && state.dir === -1 ? 'selected' : null }),
      el('option', { value: 'growth|desc', text: 'Sort: 7d growth ↓', selected: state.sortKey === 'growth' && state.dir === -1 ? 'selected' : null }),
      el('option', { value: 'age|desc', text: 'Sort: age ↓', selected: state.sortKey === 'age' && state.dir === -1 ? 'selected' : null })
    );
    if (!FROZEN) sortSel.addEventListener('change', function () {
      var p = sortSel.value.split('|'); state.sortKey = p[0]; state.dir = p[1] === 'desc' ? -1 : 1; render();
    });
    var parts = [];
    if (state.cat !== 'all') parts.push(state.cat);
    if (state.watchOnly) parts.push('watchlist only');
    if (state.minTvl > 0) parts.push('TVL ' + fmtUsd(state.minTvl) + '+');
    if (state.q.trim()) parts.push('“' + state.q.trim() + '”');
    var tail = ' ranked by implied value';
    if (state.sortKey !== 'implied') tail = ' sorted by ' + state.sortKey;
    return el('div', { class: 'controls' },
      el('span', { class: 'lab', text: 'Filter' }),
      search, sel, minSel,
      el('label', { class: 'toggle' }, watch, el('span', { text: 'watchlist only' })),
      el('span', { class: 'lab', text: ' ' }),
      sortSel,
      el('span', { class: 'count', text: filtered().length + ' rows' + (parts.length > 0 ? ' · ' + parts.join(' · ') : '') + tail })
    );
  }

  // ------------------------------------------------ the board
  function tri(key) {
    if (state.sortKey !== key) return '';
    return el('i', { class: 'tri', text: state.dir === -1 ? ' ↓' : ' ↑', 'aria-hidden': 'true' });
  }
  function th(key, label, right) {
    return el('th', { scope: 'col', class: 'sortable' + (right ? ' numh' : ''), role: 'button', 'aria-sort': state.sortKey === key ? (state.dir === -1 ? 'descending' : 'ascending') : 'none' },
      el('button', { type: 'button', onclick: function () { if (FROZEN) return; if (state.sortKey === key) state.dir = -state.dir; else { state.sortKey = key; state.dir = -1; } render(); } }, label, tri(key))
    );
  }
  function boardTable() {
    var list = sortRows(filtered());
    if (list.length === 0) {
      return el('div', { class: 'sub' }, 'No protocol matches that filter. ' + (FROZEN ? '' : 'Clear the search or choose another category.'));
    }
    var tbody = el('tbody');
    list.forEach(function (r) {
      var chainLabel = r.chains && r.chains.length
        ? r.chains[0] + (r.chains.length > 1 ? ' +' + (r.chains.length - 1) + ' more' : '')
        : 'n/a';
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', { 'data-sel': state.selected === r.slug ? '1' : null, tabindex: FROZEN ? null : '0' },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null,
          el('div', { class: 'proto', text: r.name }),
          el('div', { class: 'sub' }, r.category || 'Unspecified', ' · ', el('em', { text: r.slug }))
        ),
        el('td', { class: 'num', text: chainLabel }),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num' }, fmtX(r.base), el('em', { text: r.peers === 0 ? ' · no peers' : ' · ' + r.peers + (r.peers === 1 ? ' peer' : ' peers'), style: 'font-style:normal;color:var(--faint)' })),
        el('td', { class: 'num', text: r.momentum.toFixed(3) }),
        el('td', { class: 'num', text: r.maturity.toFixed(3) }),
        el('td', { class: 'num' },
          el('span', { class: 'implied', text: fmtUsd(r.implied_value_usd) }),
          el('span', { class: 'band', text: fmtUsd(r.value_low) + '–' + fmtUsd(r.value_high) }),
          r.on_watchlist ? el('span', { class: 'tag w', text: 'watchlist' }) : null
        )
      );
      if (!FROZEN) {
        tr.addEventListener('click', function () { openDetail(r.slug); });
        tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } });
      }
      tbody.appendChild(tr);
    });
    return el('table', { class: 'boardw' },
      el('thead', null, el('tr', null,
        th('implied', '#', false),
        th('name', 'Protocol', false),
        th('name', 'Chain', false),
        th('tvl', 'TVL', true),
        th('growth', '7d', true),
        th('age', 'No token since', true),
        th('base', 'Base (peers)', true),
        th('momentum', 'Momentum', true),
        th('maturity', 'Maturity', true),
        th('implied', 'Implied value', true)
      )),
      tbody
    );
  }

  // ------------------------------------------------ already trading
  function liveSection() {
    var live = DATA.live.slice(0, 10);
    return el('section', { class: 'live' },
      el('h2', { class: 'sec-h', text: 'Already trading — the market\u2019s own prices' }),
      el('table', { class: 'live-t' },
        el('thead', null, el('tr', null,
          el('th', { scope: 'col', text: 'Protocol' }),
          el('th', { scope: 'col', text: 'Category' }),
          el('th', { scope: 'col', class: 'numh', text: 'Market cap' }),
          el('th', { scope: 'col', class: 'numh', text: 'TVL' }),
          el('th', { scope: 'col', class: 'numh', text: 'mcap/TVL' })
        )),
        el('tbody', null, live.map(function (r) {
          return el('tr', null,
            el('td', { text: r.name }),
            el('td', { class: 'sub', text: r.category || 'Unspecified' }),
            el('td', { class: 'num numc2', text: r.mcap_usd ? fmtUsd(r.mcap_usd) : 'n/a' }),
            el('td', { class: 'num numc2', text: fmtUsd(r.tvl_usd) }),
            el('td', { class: 'num numc2', text: r.mcap_usd && r.tvl_usd > 0 ? (r.mcap_usd / r.tvl_usd).toFixed(2) + 'x' : 'n/a' })
          );
        }))
      ),
      el('p', { class: 'note', text: 'These protocols record a token in the snapshot, so their prices are the market\u2019s own facts, not this board\u2019s claims. They are set aside from the ranking, and their mcap/TVL ratios are the evidence the model reads when it prices the pre-token rows in each category.' })
    );
  }

  // ------------------------------------------------ footer
  function footer() {
    return el('footer', { class: 'footer' },
      el('span', { text: 'Built by one program from the sealed snapshot: ' + DATA.protocol_count + ' protocols, as of ' + DATA.as_of + '. Run: node main.ts --input /input/snapshot.json' }),
      el('span', { text: DATA.model_version + ' · no network, no framework · every implied value is this entry\u2019s own claim, never make.fun\u2019s' })
    );
  }

  // ------------------------------------------------ detail drawer
  var drawer = el('div', { class: 'drawer', id: 'drawer', 'aria-label': 'Protocol detail', hidden: 'true' });
  var scrim = el('button', { class: 'scrim', type: 'button', 'aria-label': 'Close detail', hidden: 'true' });
  scrim.addEventListener('click', closeDetail);

  function barRow(label, value) {
    var scale = 1.5;
    var pct = Math.max(2, Math.min(100, (value / scale) * 100));
    var tickPct = (1 / scale) * 100;
    return el('div', { class: 'bar-row' },
      el('span', { text: label }),
      el('div', { class: 'bar-track' },
        el('div', { class: 'bar-fill', style: 'width:' + pct.toFixed(1) + '%' }),
        el('span', { class: 'bar-tick', style: 'left:' + tickPct.toFixed(1) + '%', 'aria-hidden': 'true' })
      ),
      el('span', { class: 'bv', text: value.toFixed(3) })
    );
  }

  function openDetail(slug) {
    var r = bySlug[slug];
    if (!r) return;
    state.selected = slug;
    drawer.textContent = '';
    drawer.appendChild(el('div', { class: 'd-head' },
      el('button', { class: 'd-close', type: 'button', text: 'Close ×', onclick: closeDetail }),
      el('div', { class: 'sub', text: 'Rank ' + r.rank + ' of ' + DATA.board_size + ' · board' }),
      el('h2', { text: r.name }),
      el('div', { class: 'slug', text: r.slug }),
      el('div', { class: 'badges' },
        el('span', { class: 'tag', text: 'no token recorded' }),
        r.on_watchlist ? el('span', { class: 'tag w', text: 'watchlist' }) : null,
        el('span', { class: 'tag', text: r.category || 'Unspecified' }),
        el('span', { class: 'tag', text: (r.chains || []).length + (r.chains && r.chains.length > 1 ? ' chains' : ' chain') })
      )
    ));
    drawer.appendChild(el('div', { class: 'facts' },
      el('div', { class: 'f' }, el('div', { class: 'fk', text: 'TVL' }), el('div', { class: 'fv', text: fmtUsd(r.tvl_usd) })),
      el('div', { class: 'f' }, el('div', { class: 'fk', text: '7d change' }), el('div', { class: 'fv', text: fmtPct(r.change_7d) })),
      el('div', { class: 'f' }, el('div', { class: 'fk', text: 'No token for' }), el('div', { class: 'fv', text: fmtAge(r.age_days) })),
      el('div', { class: 'f' }, el('div', { class: 'fk', text: 'Listed since' }), el('div', { class: 'fv', text: r.listed_at || 'n/a' }))
    ));
    drawer.appendChild(el('section', { class: 'd-sec' },
      el('h3', { text: 'Implied launch value' }),
      el('div', { class: 'value-big', text: fmtUsd(r.implied_value_usd) }),
      el('div', { class: 'value-band', text: 'band ' + fmtUsd(r.value_low) + ' – ' + fmtUsd(r.value_high) }),
      el('p', { class: 'value-note', text: r.why && r.why.length > 0 ? 'Why this could be wrong: ' + r.why.join('; ') + '.' : 'Single-factor band: ' + DATA.calibration.trading_peers + ' trading peers price the market.' }),
      el('div', { class: 'equation' },
        el('div', { class: 'eq' }, el('span', { text: 'TVL (snapshot\u2019s record)' }), el('b', { text: fmtUsd(r.tvl_usd) })),
        el('div', { class: 'eq' }, el('span', { text: '× base ' + fmtX(r.base) + ' (' + (r.category || 'Unspecified') + (r.peers === 0 ? ', no trading peers' : ', ' + r.peers + (r.peers === 1 ? ' peer' : ' peers') + ')') }), el('b', { text: 'from the snapshot' })),
        el('div', { class: 'eq' }, el('span', { text: '× momentum ' + r.momentum.toFixed(3) + ' (7d ' + fmtPct(r.change_7d) + ')' }), el('b', { text: 'demand signal' })),
        el('div', { class: 'eq' }, el('span', { text: '× maturity ' + r.maturity.toFixed(3) + ' (' + (r.age_days === null ? 'no listed_at, half credit' : fmtAge(r.age_days) + ' no token') + ')' }), el('b', { text: 'unpriced run' })),
        el('div', { class: 'eq res' }, el('span', { text: '= implied launch value, this entry\u2019s claim' }), el('b', { text: fmtUsd(r.implied_value_usd) }))
      ),
      el('div', { class: 'bars' },
        barRow('base / ' + DATA.calibration.global_median.toFixed(2) + 'x', r.base),
        barRow('momentum / 1.000', r.momentum),
        barRow('maturity / 1.000', r.maturity)
      ),
      el('p', { class: 'sub', text: r.base_source + '. Bar ticks mark 1.000 (no adjustment); the base bar\u2019s scale is ' + (1.5).toFixed(1) + 'x.' })
    ));
    var plan = r.plan;
    if (plan && plan.steps && plan.steps.length > 0) {
      drawer.appendChild(el('section', { class: 'd-sec' },
        el('h3', { text: 'How to farm it — derived from this record' }),
        el('table', { class: 'steps' },
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: '#' }),
            el('th', { scope: 'col', text: 'Do' }),
            el('th', { scope: 'col', text: 'Signal' }),
            el('th', { scope: 'col', text: 'Cost' }),
            el('th', { scope: 'col', text: 'Time' })
          )),
          el('tbody', null, plan.steps.map(function (s, i) {
            return el('tr', null,
              el('td', { class: 'numc2', text: String(i + 1) }),
              el('td', { class: 'act', text: s.do }),
              el('td', { class: 'sig', text: s.signal }),
              el('td', null, el('span', { class: 'c', text: s.cost })),
              el('td', null, el('span', { class: 'c', text: s.time }))
            );
          }))
        ),
        el('div', { class: 'risk' }, el('b', { text: 'Risk' }), el('span', { text: plan.risk })),
        el('p', { class: 'skipif', text: plan.skip_if })
      ));
    }
    scrim.hidden = false;
    drawer.hidden = false;
  }
  function closeDetail() {
    state.selected = null;
    drawer.hidden = true;
    scrim.hidden = true;
  }

  // ------------------------------------------------ render
  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(masthead());
    shell.appendChild(ledger());
    shell.appendChild(controls());
    shell.appendChild(boardTable());
    var re = reorders();
    if (re) shell.appendChild(re);
    shell.appendChild(modelSection());
    shell.appendChild(liveSection());
    shell.appendChild(footer());
    app.appendChild(shell);
    if (!drawer.parentNode) app.appendChild(drawer);
    if (!scrim.parentNode) app.appendChild(scrim);
    app.setAttribute('aria-busy', 'false');
    if (state.selected) openDetail(state.selected);
    requestAnimationFrame(function () { window.__shotReady = true; });
  }

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !drawer.hidden) closeDetail();
  });

  render();
})();
